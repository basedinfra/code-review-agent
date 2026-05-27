// Request authorization for the agent's RPC surface.
//
// Two gates, both required (Sprint 4 scope):
//   1. Source must be a tailnet IP (the dashboard reaches the agent over
//      WireGuard; nothing else should).
//   2. A `Bearer` session token must be present and STRUCTURALLY valid
//      (`parseToken` — regex + CRC). NOTE: the CRC is a corruption/typo guard,
//      NOT a secret — it does NOT prove the dashboard issued the token, and any
//      tailnet peer could mint a structurally-valid one. In Sprint 4 the
//      tailnet-membership gate (1) is therefore the real security boundary;
//      cryptographic verification of the rotating `rpc` token against the
//      dashboard is Sprint 5 (see README "Security model"). This is a deliberate,
//      documented scope line, not an oversight.

import { parseToken } from './token.js';
import { isLoopbackIp, isTailnetIp, normalizeIp } from './net.js';

// The trailing space is load-bearing and matches the dashboard's BEARER_PREFIX.
const BEARER_PREFIX = 'Bearer ';

/**
 * Extract the token from an `Authorization` header value, or null.
 *
 * @param {string | string[] | undefined} headerValue
 * @returns {string | null}
 */
export function extractBearer(headerValue) {
	const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof value !== 'string' || !value.startsWith(BEARER_PREFIX)) return null;
	const token = value.slice(BEARER_PREFIX.length).trim();
	return token.length > 0 ? token : null;
}

/**
 * Authorize an inbound request against both gates.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ allowLoopback?: boolean }} [opts]
 * @returns {{ ok: true, token: { publicId: string, secret: string } }
 *   | { ok: false, status: number, error: string }}
 */
export function authorize(req, opts = {}) {
	const remote = normalizeIp(req.socket?.remoteAddress);
	const sourceOk = isTailnetIp(remote) || (opts.allowLoopback && isLoopbackIp(remote));
	if (!sourceOk) {
		// 403, not 401: the caller is on the wrong network, not merely unauthenticated.
		return { ok: false, status: 403, error: 'Forbidden: requests must originate from the tailnet' };
	}

	const bearer = extractBearer(req.headers?.authorization);
	if (!bearer) {
		return { ok: false, status: 401, error: 'Unauthorized: missing Bearer token' };
	}
	const token = parseToken(bearer);
	if (!token) {
		return { ok: false, status: 401, error: 'Unauthorized: malformed token' };
	}
	return { ok: true, token };
}
