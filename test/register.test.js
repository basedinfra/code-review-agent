import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, buildRegisterBody, FatalRegisterError, register } from '../src/register.js';

function fetchSequence(responses) {
	const calls = [];
	const impl = async (url, opts) => {
		calls.push({ url, opts });
		const r = responses[Math.min(calls.length - 1, responses.length - 1)];
		return { status: r.status, json: async () => r.body ?? {} };
	};
	impl.calls = calls;
	return impl;
}

const noSleep = async () => {};
const base = {
	registerUrl: 'https://d.example.com/register',
	token: 'bisess_tok',
	body: { agent_version: '1.0.0' }
};

test('register resolves on 200', async () => {
	const fetchImpl = fetchSequence([
		{ status: 200, body: { ok: true, backendId: 42, status: 'connected' } }
	]);
	const result = await register({ ...base, fetchImpl, sleepImpl: noSleep });
	assert.equal(result.backendId, 42);
	assert.equal(result.status, 'connected');
	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer bisess_tok');
});

test('register treats 401 as fatal without retrying', async () => {
	const fetchImpl = fetchSequence([{ status: 401 }]);
	await assert.rejects(
		() => register({ ...base, fetchImpl, sleepImpl: noSleep }),
		FatalRegisterError
	);
	assert.equal(fetchImpl.calls.length, 1);
});

test('register treats 400 as fatal', async () => {
	const fetchImpl = fetchSequence([{ status: 400 }]);
	await assert.rejects(
		() => register({ ...base, fetchImpl, sleepImpl: noSleep }),
		FatalRegisterError
	);
});

test('register retries 409 (token not burned) then succeeds', async () => {
	const fetchImpl = fetchSequence([
		{ status: 409 },
		{ status: 409 },
		{ status: 200, body: { backendId: 7, status: 'connected' } }
	]);
	const result = await register({ ...base, fetchImpl, sleepImpl: noSleep });
	assert.equal(result.backendId, 7);
	assert.equal(fetchImpl.calls.length, 3);
});

test('register retries 429 then gives up after maxAttempts', async () => {
	const fetchImpl = fetchSequence([{ status: 429 }]);
	await assert.rejects(
		() => register({ ...base, fetchImpl, sleepImpl: noSleep, maxAttempts: 3 }),
		(e) => !(e instanceof FatalRegisterError) && /exhausted 3/.test(e.message)
	);
	assert.equal(fetchImpl.calls.length, 3);
});

test('register requires a URL and a token', async () => {
	await assert.rejects(
		() => register({ ...base, registerUrl: null, sleepImpl: noSleep }),
		FatalRegisterError
	);
	await assert.rejects(
		() => register({ ...base, token: null, sleepImpl: noSleep }),
		FatalRegisterError
	);
});

test('register retries transient network errors', async () => {
	const calls = [];
	const fetchImpl = async () => {
		calls.push(1);
		if (calls.length < 2) throw new Error('ECONNREFUSED');
		return { status: 200, json: async () => ({ backendId: 1, status: 'connected' }) };
	};
	const result = await register({ ...base, fetchImpl, sleepImpl: noSleep });
	assert.equal(result.backendId, 1);
	assert.equal(calls.length, 2);
});

test('buildRegisterBody maps host identity and includes optional fields', () => {
	const body = buildRegisterBody({
		agentVersion: '1.0.0',
		maxConcurrentReviews: 3,
		warnings: [{ kind: 'low_resources' }],
		platform: 'darwin',
		arch: 'arm64'
	});
	assert.deepEqual(body, {
		agent_version: '1.0.0',
		host_os: 'darwin',
		host_arch: 'arm64',
		max_concurrent_reviews: 3,
		warnings: [{ kind: 'low_resources' }]
	});

	const linux = buildRegisterBody({ agentVersion: '1.0.0', platform: 'linux', arch: 'x64' });
	assert.equal(linux.host_os, 'linux');
	assert.equal(linux.host_arch, 'x86_64');
	assert.equal('max_concurrent_reviews' in linux, false);
	assert.equal('warnings' in linux, false);

	const win = buildRegisterBody({ agentVersion: '1.0.0', platform: 'win32', arch: 'mips' });
	assert.equal(win.host_os, 'unknown');
	assert.equal(win.host_arch, 'unknown');
});

test('backoffDelay stays within [ceil/2, ceil] and is capped', () => {
	for (let attempt = 0; attempt < 10; attempt++) {
		const ceil = Math.min(30000, 1000 * 2 ** attempt);
		const d = backoffDelay(attempt, 1000, 30000);
		assert.ok(
			d >= Math.floor(ceil / 2) && d <= ceil,
			`attempt ${attempt}: ${d} not in [${ceil / 2}, ${ceil}]`
		);
	}
});
