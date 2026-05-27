// Pure IP helpers for the tailnet-source gate. No I/O.
//
// The agent's RPC surface is reachable only over the Headscale/Tailscale tailnet:
// the HTTP server binds the tailnet address and every authenticated request must
// originate from a tailnet source. Tailscale assigns IPv4 in the 100.64.0.0/10
// CGNAT range and IPv6 in the fd7a:115c:a1e0::/48 ULA range.

const TAILNET_V6_PREFIX = 'fd7a:115c:a1e0:';

/**
 * Normalize a Node `socket.remoteAddress`: strip the IPv4-mapped-IPv6 prefix so
 * `::ffff:100.64.0.1` compares as `100.64.0.1`.
 *
 * @param {string | undefined | null} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
	if (typeof ip !== 'string') return '';
	const trimmed = ip.trim();
	return trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

/**
 * Is `ip` inside the Tailscale tailnet (IPv4 100.64.0.0/10 or IPv6
 * fd7a:115c:a1e0::/48)?
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isTailnetIp(ip) {
	const addr = normalizeIp(ip);
	if (!addr) return false;
	if (addr.includes(':')) return addr.startsWith(TAILNET_V6_PREFIX);
	const octets = addr.split('.');
	if (octets.length !== 4) return false;
	const nums = octets.map((o) => Number(o));
	if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	// 100.64.0.0/10 → first octet 100, second octet 64–127.
	return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
}

/**
 * Loopback (127.0.0.0/8 or ::1). Only honored on the RPC gate when explicitly
 * allowed (tests / local dev), never in production.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isLoopbackIp(ip) {
	const addr = normalizeIp(ip);
	if (!addr) return false;
	if (addr === '::1') return true;
	const octets = addr.split('.');
	return octets.length === 4 && octets[0] === '127';
}

/**
 * First tailnet IPv4 address across the host's interfaces, or null. Under
 * `network_mode: host` this surfaces the host's `tailscale0` 100.x address.
 *
 * @param {Record<string, Array<{ family?: string, address?: string, internal?: boolean }>>} interfaces
 * @returns {string | null}
 */
export function findTailnetIp(interfaces) {
	for (const addrs of Object.values(interfaces || {})) {
		for (const a of addrs || []) {
			if (a && a.family === 'IPv4' && !a.internal && isTailnetIp(a.address || '')) {
				return a.address;
			}
		}
	}
	return null;
}
