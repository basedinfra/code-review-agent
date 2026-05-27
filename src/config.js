// Environment-driven configuration. One frozen object, resolved once at boot.
//
// The bind address is the security-critical field: the server must listen on the
// tailnet IP, never 0.0.0.0. We resolve it from an explicit `AGENT_BIND_IP`
// override (tests/dev use 127.0.0.1) or by auto-detecting the host's tailnet
// interface. `index.js` refuses to start if neither yields a safe address.

import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import { findTailnetIp } from './net.js';

const DEFAULT_PORT = 7777;
const DEFAULT_DOCKER_HOST = 'tcp://socket-proxy:2375';
const DEFAULT_PR_AGENT_IMAGE = 'codiumai/pr-agent:latest';
const DEFAULT_PR_AGENT_PLATFORM = 'linux/amd64';
const DEFAULT_PR_AGENT_MEMORY = '2g';
const DEFAULT_MAX_CONCURRENT_REVIEWS = 3;
const REGISTER_PATH = '/api/agents/code-review/register';

function readPackageVersion() {
	try {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * Read the bootstrap token from `BACKEND_BOOTSTRAP_TOKEN` or a `0600` file
 * (`BISESS_TOKEN_FILE`). Never logged; never passed via argv.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function readBootstrapToken(env) {
	const fromEnv = env.BACKEND_BOOTSTRAP_TOKEN?.trim();
	if (fromEnv) return fromEnv; // empty/whitespace-only → fall through to null
	if (env.BISESS_TOKEN_FILE) {
		try {
			// Warn (don't hard-fail) if the token file is group/other-accessible.
			if ((statSync(env.BISESS_TOKEN_FILE).mode & 0o077) !== 0) {
				console.warn(
					`[agent] WARNING: ${env.BISESS_TOKEN_FILE} is group/other-accessible; chmod 600 it.`
				);
			}
			return readFileSync(env.BISESS_TOKEN_FILE, 'utf8').trim() || null;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Resolve the address the HTTP server should bind. Explicit override wins;
 * otherwise auto-detect the tailnet interface.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, any>} [interfaces] os.networkInterfaces() (injectable)
 * @returns {{ bindIp: string | null, explicit: boolean }}
 */
export function resolveBindIp(env, interfaces = os.networkInterfaces()) {
	if (env.AGENT_BIND_IP) return { bindIp: env.AGENT_BIND_IP.trim(), explicit: true };
	return { bindIp: findTailnetIp(interfaces), explicit: false };
}

function toInt(value, fallback) {
	const n = Number.parseInt(value, 10);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<object>}
 */
export function loadConfig(env = process.env) {
	const { bindIp, explicit } = resolveBindIp(env);
	const dashboardUrl = env.DASHBOARD_URL ? env.DASHBOARD_URL.replace(/\/+$/, '') : null;
	const registerUrl = env.REGISTER_URL || (dashboardUrl ? `${dashboardUrl}${REGISTER_PATH}` : null);

	return Object.freeze({
		port: toInt(env.PORT, DEFAULT_PORT),
		bindIp,
		bindIpExplicit: explicit,
		allowLoopback: env.AGENT_ALLOW_LOOPBACK === 'true' || env.AGENT_ALLOW_LOOPBACK === '1',
		dockerHost: env.DOCKER_HOST || DEFAULT_DOCKER_HOST,
		dashboardUrl,
		registerUrl,
		backendId: env.BACKEND_ID || null,
		bootstrapToken: readBootstrapToken(env),
		agentVersion: env.AGENT_VERSION || readPackageVersion(),
		maxConcurrentReviews: toInt(env.MAX_CONCURRENT_REVIEWS, DEFAULT_MAX_CONCURRENT_REVIEWS),
		prAgentImage: env.PR_AGENT_IMAGE || DEFAULT_PR_AGENT_IMAGE,
		prAgentPlatform: env.PR_AGENT_PLATFORM || DEFAULT_PR_AGENT_PLATFORM,
		prAgentMemory: env.PR_AGENT_MEMORY || DEFAULT_PR_AGENT_MEMORY,
		prAgentNetwork: env.PR_AGENT_NETWORK || null
	});
}

/**
 * Map `process.platform`/`process.arch` to the dashboard's host_os/host_arch
 * vocabulary (`darwin | linux | unknown`, `arm64 | x86_64 | unknown`).
 *
 * @returns {{ host_os: string, host_arch: string }}
 */
export function hostIdentity(platform = process.platform, arch = process.arch) {
	const host_os = platform === 'darwin' || platform === 'linux' ? platform : 'unknown';
	const archMap = { arm64: 'arm64', x64: 'x86_64' };
	return { host_os, host_arch: archMap[arch] || 'unknown' };
}
