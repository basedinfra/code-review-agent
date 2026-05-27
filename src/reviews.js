// Per-review orchestration: each /review runs an ephemeral PR-Agent container
// through the socket-proxy. Provider keys live only in the container's env (and
// only for the container's lifetime) — never on the agent's disk.

import crypto from 'node:crypto';
import { HttpStatusError } from './errors.js';
import {
	buildPrAgentCreateConfig,
	buildPrAgentEnv,
	defaultPrAgentCmd,
	parseMemoryToBytes
} from './pragent.js';

export const LABEL_MANAGED = 'baseinfra.code-review.managed';
export const LABEL_REVIEW_ID = 'baseinfra.code-review.review-id';
export const DEFAULT_LOG_TAIL = 1000;

// Cancellation stops tightly (we are tearing down, not graceful-stopping); the
// DockerClient default (10s) covers ordinary stops.
const CANCEL_STOP_TIMEOUT_SECS = 5;

/**
 * @typedef {{ reviewId: string, containerId: string, status: string, prUrl: string, startedAt: number }} ReviewRecord
 */

export class Reviews {
	/**
	 * @param {{ docker: import('./docker-client.js').DockerClient, config: object, log?: (msg: string) => void }} deps
	 */
	constructor({ docker, config, log = () => {} }) {
		this.docker = docker;
		this.config = config;
		this.log = log;
		this.memoryBytes = parseMemoryToBytes(config.prAgentMemory);
		/** reviewId → record, for the cancel/logs fast path (not the cap source). */
		this.active = new Map();
		// Synchronous count of in-flight start() calls — containers being created
		// but not yet observable as "running". Reserved before any await so a
		// burst of concurrent /review calls can't over-admit past the cap.
		this._starting = 0;
		this._imagePulled = false;
	}

	/**
	 * Authoritative count of *running* review containers, read from Docker — so a
	 * completed or removed container stops counting (no in-memory drift, which was
	 * the old `_inFlight` counter's bug). Falls back to 0 if Docker is unreachable
	 * (createContainer then fails loudly rather than silently blocking).
	 *
	 * @returns {Promise<number>}
	 */
	async runningCount() {
		try {
			const list = await this.docker.listContainers({
				all: false,
				label: `${LABEL_MANAGED}=true`
			});
			return Array.isArray(list) ? list.length : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * Pre-pull the PR-Agent image (warm the cache before the first review).
	 *
	 * @returns {Promise<{ image: string, platform: string }>}
	 */
	async pullImage() {
		await this.docker.pullImage(this.config.prAgentImage, {
			platform: this.config.prAgentPlatform
		});
		this._imagePulled = true;
		return { image: this.config.prAgentImage, platform: this.config.prAgentPlatform };
	}

	/**
	 * Start a review.
	 *
	 * @param {{
	 *   pr_url?: string,
	 *   command?: string,
	 *   provider_keys?: Record<string, string>,
	 *   github_token?: string,
	 *   model?: string,
	 *   reasoning_effort?: string,
	 *   cmd?: string[]
	 * }} body
	 * @returns {Promise<{ reviewId: string, containerId: string, status: string }>}
	 */
	async start(body = {}) {
		const prUrl = body.pr_url;
		if (typeof prUrl !== 'string' || !prUrl) {
			throw new HttpStatusError(400, 'pr_url is required');
		}

		// Reserve a slot synchronously (before the first await) so concurrent
		// /review calls can't all read the same pre-await count and over-admit.
		this._starting++;
		try {
			const running = await this.runningCount();
			// running = already-running containers; _starting includes this call.
			if (running + this._starting - 1 >= this.config.maxConcurrentReviews) {
				throw new HttpStatusError(429, 'agent at max concurrent reviews');
			}

			const reviewId = crypto.randomUUID();
			const env = buildPrAgentEnv({
				providerKeys: body.provider_keys || {},
				githubToken: body.github_token,
				model: body.model,
				reasoningEffort: body.reasoning_effort
			});
			const createConfig = buildPrAgentCreateConfig({
				image: this.config.prAgentImage,
				env,
				cmd: Array.isArray(body.cmd) ? body.cmd : defaultPrAgentCmd(body.command, prUrl),
				memoryBytes: this.memoryBytes,
				networkMode: this.config.prAgentNetwork,
				labels: { [LABEL_MANAGED]: 'true', [LABEL_REVIEW_ID]: reviewId }
			});

			// Pull once per process — the image rarely changes mid-session and the
			// explicit /pull-images endpoint exists for proactive warming. A missing
			// image still surfaces via createContainer below.
			if (!this._imagePulled) {
				try {
					await this.docker.pullImage(this.config.prAgentImage, {
						platform: this.config.prAgentPlatform
					});
					this._imagePulled = true;
				} catch (e) {
					this.log(`pull failed (continuing if cached): ${e.message}`);
				}
			}

			const created = await this.docker.createContainer(`cr-review-${reviewId}`, createConfig, {
				platform: this.config.prAgentPlatform
			});
			try {
				await this.docker.startContainer(created.Id);
			} catch (e) {
				// Don't leak a created-but-unstarted container (with its secret env).
				await this.docker.removeContainer(created.Id, { force: true }).catch(() => {});
				throw e;
			}

			this.active.set(reviewId, {
				reviewId,
				containerId: created.Id,
				status: 'running',
				prUrl,
				startedAt: Date.now()
			});
			this.log(`review ${reviewId} started (container ${created.Id.slice(0, 12)})`);
			return { reviewId, containerId: created.Id, status: 'running' };
		} finally {
			this._starting--;
		}
	}

	/**
	 * Cancel a review: stop + remove its container, then evict the record. The
	 * record is evicted ONLY after a successful removal (removeContainer throws on
	 * a non-2xx/404 status), so a failed teardown never reports a false "cancelled"
	 * while the container keeps running.
	 *
	 * @param {string} reviewId
	 * @returns {Promise<{ reviewId: string, status: string }>}
	 */
	async cancel(reviewId) {
		const containerId = await this._resolveContainer(reviewId);
		// Best-effort stop; the force-remove below is the real teardown.
		await this.docker.stopContainer(containerId, { t: CANCEL_STOP_TIMEOUT_SECS }).catch(() => {});
		await this.docker.removeContainer(containerId, { force: true });
		this.active.delete(reviewId);
		this.log(`review ${reviewId} cancelled`);
		return { reviewId, status: 'cancelled' };
	}

	/**
	 * Tail a review's container logs.
	 *
	 * @param {string} reviewId
	 * @param {{ tail?: number }} [opts]
	 * @returns {Promise<string>}
	 */
	async logs(reviewId, { tail = DEFAULT_LOG_TAIL } = {}) {
		const containerId = await this._resolveContainer(reviewId);
		return this.docker.collectLogs(containerId, { tail });
	}

	/**
	 * Resolve a reviewId to a container id (in-memory first, then by label so a
	 * restarted agent can still address running reviews).
	 *
	 * @param {string} reviewId
	 * @returns {Promise<string>}
	 */
	async _resolveContainer(reviewId) {
		const record = this.active.get(reviewId);
		if (record?.containerId) return record.containerId;
		try {
			const list = await this.docker.listContainers({
				all: true,
				label: `${LABEL_REVIEW_ID}=${reviewId}`
			});
			if (Array.isArray(list) && list[0]?.Id) return list[0].Id;
		} catch {
			// fall through to 404
		}
		throw new HttpStatusError(404, `unknown review: ${reviewId}`);
	}
}
