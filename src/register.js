// One-shot register against the dashboard's shipped contract:
//
//   POST <dashboard>/api/agents/code-review/register
//   Authorization: Bearer bisess_<id>_<secret>_<crc>
//   { agent_version, host_os?, host_arch?, max_concurrent_reviews?, warnings? }
//
//   200 { ok, backendId, status:'connected' }  → done
//   401 / 400                                   → FATAL (bad/expired token; re-pair)
//   409 / 429                                   → retriable (token NOT burned)
//
// The 409 retry is load-bearing: after `tailscale up` the node takes a few
// seconds to appear online in Headscale, and the dashboard returns 409 until then
// WITHOUT consuming the single-use bootstrap token — so the same token survives
// the backoff loop.

import { pathToFileURL } from 'node:url';
import { DockerClient } from './docker-client.js';
import { hostIdentity, loadConfig } from './config.js';
import { runSystemCheck } from './system-check.js';

export class FatalRegisterError extends Error {
	constructor(message) {
		super(message);
		this.name = 'FatalRegisterError';
	}
}

const RETRIABLE = new Set([409, 429]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the register body from agent + host identity.
 *
 * @param {{ agentVersion: string, maxConcurrentReviews?: number, warnings?: Array<object>, platform?: string, arch?: string }} opts
 * @returns {object}
 */
export function buildRegisterBody({
	agentVersion,
	maxConcurrentReviews,
	warnings = [],
	platform,
	arch
} = {}) {
	const { host_os, host_arch } = hostIdentity(platform, arch);
	const body = { agent_version: agentVersion, host_os, host_arch };
	if (Number.isInteger(maxConcurrentReviews)) body.max_concurrent_reviews = maxConcurrentReviews;
	if (warnings.length) body.warnings = warnings;
	return body;
}

/**
 * Exponential backoff with jitter, capped.
 *
 * @param {number} attempt 0-based
 * @param {number} baseMs
 * @param {number} capMs
 * @returns {number}
 */
export function backoffDelay(attempt, baseMs, capMs) {
	const ceil = Math.min(capMs, baseMs * 2 ** attempt);
	return Math.floor(ceil / 2 + Math.random() * (ceil / 2));
}

/**
 * Register with bounded exponential backoff on transient (409/429) responses.
 * Pure-ish: `fetchImpl`/`sleepImpl` are injectable for tests.
 *
 * @param {{
 *   registerUrl: string | null,
 *   token: string | null,
 *   body: object,
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   capDelayMs?: number,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   log?: (m: string) => void
 * }} opts
 * @returns {Promise<{ ok: boolean, backendId: number, status: string }>}
 */
export async function register({
	registerUrl,
	token,
	body,
	maxAttempts = 8,
	baseDelayMs = 1000,
	capDelayMs = 30000,
	fetchImpl = fetch,
	sleepImpl = sleep,
	log = () => {}
}) {
	if (!registerUrl) {
		throw new FatalRegisterError('no register URL (set DASHBOARD_URL or REGISTER_URL)');
	}
	if (!token) {
		throw new FatalRegisterError(
			'no bootstrap token (set BACKEND_BOOTSTRAP_TOKEN or BISESS_TOKEN_FILE)'
		);
	}

	let lastErr;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		let res;
		try {
			res = await fetchImpl(registerUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});
		} catch (e) {
			lastErr = e;
			log(`attempt ${attempt + 1}: network error: ${e.message}`);
			await sleepImpl(backoffDelay(attempt, baseDelayMs, capDelayMs));
			continue;
		}

		if (res.status === 200) {
			const json = await res.json().catch(() => ({}));
			log(`registered: backend ${json.backendId} → ${json.status}`);
			return json;
		}
		if (res.status === 401 || res.status === 400) {
			throw new FatalRegisterError(`register failed (${res.status}); re-pair required`);
		}
		lastErr = new Error(
			`register ${RETRIABLE.has(res.status) ? 'transient' : 'unexpected'} ${res.status}`
		);
		const delay = backoffDelay(attempt, baseDelayMs, capDelayMs);
		log(`attempt ${attempt + 1} → ${res.status}, retrying in ${delay}ms`);
		await sleepImpl(delay);
	}
	throw new Error(`register exhausted ${maxAttempts} attempts: ${lastErr?.message ?? 'unknown'}`);
}

// CLI entry — the installer runs `node src/register.js` after `compose up`.
async function main() {
	const config = loadConfig();
	const docker = new DockerClient(config.dockerHost);
	const { warnings } = await runSystemCheck({ docker, config });
	const body = buildRegisterBody({
		agentVersion: config.agentVersion,
		maxConcurrentReviews: config.maxConcurrentReviews,
		warnings
	});
	try {
		await register({
			registerUrl: config.registerUrl,
			token: config.bootstrapToken,
			body,
			log: (m) => console.log(`[register] ${m}`)
		});
		process.exit(0);
	} catch (e) {
		console.error(`[register] ${e.message}`);
		// 2 = fatal (re-pair), 1 = transient exhaustion (installer may retry later).
		process.exit(e instanceof FatalRegisterError ? 2 : 1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
