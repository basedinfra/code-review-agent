import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSessionToken, parseToken, tokenPrefix } from '../src/token.js';

test('generateSessionToken round-trips through parseToken', () => {
	const { token, publicId, secret } = generateSessionToken();
	assert.match(token, /^bisess_[0-9A-Za-z]{22}_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/);
	const parsed = parseToken(token);
	assert.ok(parsed, 'a freshly minted token must parse');
	assert.equal(parsed.publicId, publicId);
	assert.equal(parsed.secret, secret);
});

test('parseToken rejects non-strings and malformed shapes', () => {
	assert.equal(parseToken(undefined), null);
	assert.equal(parseToken(null), null);
	assert.equal(parseToken(12345), null);
	assert.equal(parseToken(''), null);
	assert.equal(parseToken('bisess_tooshort'), null);
	assert.equal(
		parseToken('wrongprefix_aaaaaaaaaaaaaaaaaaaaaa_' + 'b'.repeat(43) + '_cccccc'),
		null
	);
});

test('parseToken rejects a tampered checksum', () => {
	const { token } = generateSessionToken();
	const lastChar = token.slice(-1);
	const swapped = lastChar === '0' ? '1' : '0';
	const tampered = token.slice(0, -1) + swapped;
	assert.equal(
		parseToken(tampered),
		null,
		'a flipped CRC char must fail the constant-time compare'
	);
});

test('parseToken rejects a tampered secret (checksum no longer matches)', () => {
	const { token } = generateSessionToken();
	// Flip a char inside the secret segment; the trailing CRC then mismatches.
	const idx = 'bisess_'.length + 22 + 1 + 5;
	const c = token[idx];
	const swapped = c === 'A' ? 'B' : 'A';
	const tampered = token.slice(0, idx) + swapped + token.slice(idx + 1);
	assert.equal(parseToken(tampered), null);
});

test('tokenPrefix is secret-free and short', () => {
	const { publicId } = generateSessionToken();
	const p = tokenPrefix(publicId);
	assert.match(p, /^bisess_[0-9A-Za-z]{8}$/);
});
