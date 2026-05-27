import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, extractBearer } from '../src/auth.js';
import { generateSessionToken } from '../src/token.js';

function req({ remoteAddress, authorization } = {}) {
	return { socket: { remoteAddress }, headers: authorization ? { authorization } : {} };
}

test('extractBearer requires the "Bearer " prefix (trailing space)', () => {
	assert.equal(extractBearer('Bearer abc'), 'abc');
	assert.equal(extractBearer('Bearer   spaced  '), 'spaced');
	assert.equal(extractBearer('bearer abc'), null);
	assert.equal(extractBearer('Token abc'), null);
	assert.equal(extractBearer('Bearer '), null);
	assert.equal(extractBearer(undefined), null);
});

test('authorize passes a tailnet source with a valid token', () => {
	const { token } = generateSessionToken();
	const result = authorize(req({ remoteAddress: '100.64.0.9', authorization: `Bearer ${token}` }));
	assert.equal(result.ok, true);
	assert.ok(result.token.publicId);
});

test('authorize rejects a non-tailnet source with 403 (before checking the token)', () => {
	const { token } = generateSessionToken();
	const result = authorize(req({ remoteAddress: '192.168.1.5', authorization: `Bearer ${token}` }));
	assert.equal(result.ok, false);
	assert.equal(result.status, 403);
});

test('authorize rejects a missing/malformed token from a tailnet source with 401', () => {
	const missing = authorize(req({ remoteAddress: '100.64.0.9' }));
	assert.equal(missing.status, 401);

	const malformed = authorize(
		req({ remoteAddress: '100.64.0.9', authorization: 'Bearer not-a-token' })
	);
	assert.equal(malformed.status, 401);
});

test('authorize honors allowLoopback only when enabled', () => {
	const { token } = generateSessionToken();
	const denied = authorize(req({ remoteAddress: '127.0.0.1', authorization: `Bearer ${token}` }));
	assert.equal(denied.status, 403);

	const allowed = authorize(req({ remoteAddress: '127.0.0.1', authorization: `Bearer ${token}` }), {
		allowLoopback: true
	});
	assert.equal(allowed.ok, true);
});
