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
	requestTimeoutMs = 30000,
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
				body: JSON.stringify(body),
				// Bound each attempt so a dashboard that accepts the connection but
				// stalls the response can't hang the install-time register forever;
				// a timeout aborts → caught below as a transient error → retried.
				signal: AbortSignal.timeout(requestTimeoutMs)
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
		// Retry ONLY genuinely transient statuses: 409 (tailnet node not visible
		// yet — token NOT burned), 429 (rate-limited), and 5xx (server hiccup).
		// Everything else (400/401/403/404, other 4xx) is fatal — retrying cannot
		// help and only delays surfacing the failure.
		if (res.status === 409 || res.status === 429 || res.status >= 500) {
			lastErr = new Error(`register transient ${res.status}`);
			const delay = backoffDelay(attempt, baseDelayMs, capDelayMs);
			log(`attempt ${attempt + 1} → ${res.status}, retrying in ${delay}ms`);
			await sleepImpl(delay);
			continue;
		}
		throw new FatalRegisterError(`register failed (${res.status}); not retriable`);
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
