// Structural parser for BaseInfra session tokens (`bisess_*`), byte-for-byte
// compatible with the dashboard's minting in
// `src/lib/code-review/backends/sessions.js`.
//
// The agent sees two kinds of these tokens, both STRUCTURALLY IDENTICAL:
//   - the single-use `bootstrap` token, bundled into the install script and sent
//     as the Bearer on the one-shot POST /register; and
//   - (Sprint 5) the rotating `rpc` token the dashboard presents on every
//     /review call.
// The role (`bootstrap` vs `rpc`) is a dashboard-side DB column, NOT encoded in
// the string — so `parseToken` is a role-agnostic *structural* validator
// (regex + constant-time CRC). Authoritative verification (HMAC hash + DB
// lookup) is the dashboard's responsibility; the agent only checks shape.
//
// Format: bisess_<22-char base62 publicId>_<43-char base62 secret>_<6-char base62 CRC32>

import crypto from 'node:crypto';

const TOKEN_PREFIX = 'bisess';
const PUBLIC_ID_LEN = 22;
const SECRET_LEN = 43;
const CRC_LEN = 6;
const TOKEN_REGEX = new RegExp(
	`^${TOKEN_PREFIX}_([0-9A-Za-z]{${PUBLIC_ID_LEN}})_([0-9A-Za-z]{${SECRET_LEN}})_([0-9A-Za-z]{${CRC_LEN}})$`
);

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Encode a byte buffer as fixed-length base62 (left-padded with `0`). Mirrors the
 * dashboard's `bytesToBase62`; throws on overflow (never happens for the
 * 16→22 / 32→43 / 4→6 budgets used here).
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {number} outputLength
 * @returns {string}
 */
function bytesToBase62(bytes, outputLength) {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	if (n === 0n) return '0'.repeat(outputLength);
	let out = '';
	while (n > 0n) {
		out = BASE62_ALPHABET[Number(n % 62n)] + out;
		n /= 62n;
	}
	if (out.length > outputLength) {
		throw new Error(`bytesToBase62: encoded length ${out.length} exceeds budget ${outputLength}`);
	}
	return out.padStart(outputLength, '0');
}

// CRC32 (IEEE 802.3, polynomial 0xEDB88320) — self-contained table build so the
// token format does not depend on Node's `zlib.crc32` availability.
const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/**
 * @param {string} payload
 * @returns {number} unsigned 32-bit CRC
 */
function crc32(payload) {
	const bytes = Buffer.from(payload, 'utf8');
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} payload
 * @returns {string} 6-char base62 checksum
 */
function computeChecksum(payload) {
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(payload));
	return bytesToBase62(crcBuf, CRC_LEN);
}

/**
 * Parse + structurally validate a token (regex + constant-time CRC). Does NOT
 * touch any network/DB. Returns the decomposed parts or `null` on any fault.
 *
 * @param {unknown} plaintext
 * @returns {{ publicId: string, secret: string } | null}
 */
export function parseToken(plaintext) {
	if (typeof plaintext !== 'string') return null;
	const match = TOKEN_REGEX.exec(plaintext);
	if (!match) return null;
	const [, publicId, secret, crc] = match;
	const expected = computeChecksum(`${TOKEN_PREFIX}_${publicId}_${secret}`);
	if (!crypto.timingSafeEqual(Buffer.from(crc, 'utf8'), Buffer.from(expected, 'utf8'))) {
		return null;
	}
	return { publicId, secret };
}

/**
 * Mint a structurally-valid token (pure; no DB/broker). Used by tests — the
 * dashboard mints the real ones — and kept format-identical to the dashboard's
 * `generateSessionToken` so a round-trip through {@link parseToken} proves the
 * checksum scheme matches.
 *
 * @returns {{ token: string, publicId: string, secret: string }}
 */
export function generateSessionToken() {
	const tsBuf = Buffer.alloc(6);
	let ts = BigInt(Date.now());
	for (let i = 5; i >= 0; i--) {
		tsBuf[i] = Number(ts & 0xffn);
		ts >>= 8n;
	}
	const publicId = bytesToBase62(Buffer.concat([tsBuf, crypto.randomBytes(10)]), PUBLIC_ID_LEN);
	const secret = bytesToBase62(crypto.randomBytes(32), SECRET_LEN);
	const payload = `${TOKEN_PREFIX}_${publicId}_${secret}`;
	return { token: `${payload}_${computeChecksum(payload)}`, publicId, secret };
}

/**
 * Grep-friendly, secret-free prefix for logs (never enough to redeem).
 *
 * @param {string} publicId
 * @returns {string}
 */
export function tokenPrefix(publicId) {
	return `${TOKEN_PREFIX}_${String(publicId).slice(0, 8)}`;
}
