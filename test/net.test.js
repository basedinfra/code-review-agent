import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTailnetIp, isLoopbackIp, isTailnetIp, normalizeIp } from '../src/net.js';

test('isTailnetIp accepts the 100.64.0.0/10 CGNAT range', () => {
	assert.equal(isTailnetIp('100.64.0.1'), true);
	assert.equal(isTailnetIp('100.100.50.7'), true);
	assert.equal(isTailnetIp('100.127.255.255'), true);
});

test('isTailnetIp rejects addresses just outside the range', () => {
	assert.equal(isTailnetIp('100.63.255.255'), false);
	assert.equal(isTailnetIp('100.128.0.0'), false);
	assert.equal(isTailnetIp('10.0.0.1'), false);
	assert.equal(isTailnetIp('192.168.1.1'), false);
	assert.equal(isTailnetIp('100.64.0'), false);
	assert.equal(isTailnetIp(''), false);
});

test('isTailnetIp handles the Tailscale IPv6 ULA prefix', () => {
	assert.equal(isTailnetIp('fd7a:115c:a1e0::1'), true);
	assert.equal(isTailnetIp('fd00:dead:beef::1'), false);
});

test('normalizeIp strips the IPv4-mapped IPv6 prefix', () => {
	assert.equal(normalizeIp('::ffff:100.64.0.1'), '100.64.0.1');
	assert.equal(isTailnetIp('::ffff:100.64.0.1'), true);
	assert.equal(normalizeIp(undefined), '');
});

test('isLoopbackIp', () => {
	assert.equal(isLoopbackIp('127.0.0.1'), true);
	assert.equal(isLoopbackIp('::1'), true);
	assert.equal(isLoopbackIp('100.64.0.1'), false);
});

test('findTailnetIp picks the first non-internal tailnet IPv4', () => {
	const interfaces = {
		lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
		en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
		tailscale0: [{ family: 'IPv4', address: '100.96.1.2', internal: false }]
	};
	assert.equal(findTailnetIp(interfaces), '100.96.1.2');
	assert.equal(findTailnetIp({ en0: [{ family: 'IPv4', address: '192.168.1.5' }] }), null);
	assert.equal(findTailnetIp({}), null);
});
