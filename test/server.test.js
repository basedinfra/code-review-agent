import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRequestListener } from '../src/server.js';
import { generateSessionToken } from '../src/token.js';

const { token } = generateSessionToken();

function mockRes() {
	return {
		statusCode: null,
		headers: null,
		body: '',
		headersSent: false,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
			this.headersSent = true;
		},
		end(body) {
			this.body = body ?? '';
		}
	};
}

function mockReq({ method = 'GET', url = '/', remoteAddress = '100.64.0.1', authorization, body }) {
	const req =
		body !== undefined ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	req.method = method;
	req.url = url;
	req.headers = authorization ? { authorization } : {};
	req.socket = { remoteAddress };
	return req;
}

const fakeReviews = {
	start: async () => ({ reviewId: 'rid', containerId: 'cid', status: 'running' }),
	cancel: async (id) => ({ reviewId: id, status: 'cancelled' }),
	logs: async () => 'logtext',
	pullImage: async () => ({ image: 'img', platform: 'linux/amd64' })
};
const fakeDocker = { ping: async () => true, info: async () => ({ Name: 'docker-engine test' }) };
const config = {
	allowLoopback: false,
	agentVersion: '1.0.0',
	bindIp: '100.64.0.1',
	port: 7777,
	dockerHost: 'tcp://x:2375'
};

function makeHandler() {
	return createRequestListener({
		config,
		reviews: fakeReviews,
		docker: fakeDocker,
		startedAt: Date.now(),
		log: () => {}
	});
}

async function call(reqOpts) {
	const res = mockRes();
	await makeHandler()(mockReq(reqOpts), res);
	return res;
}

test('GET /health returns 200 without auth (even from a non-tailnet source)', async () => {
	const res = await call({ method: 'GET', url: '/health', remoteAddress: '203.0.113.9' });
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.body);
	assert.ok(body.status);
	assert.equal(body.version, '1.0.0');
});

test('protected route rejects a non-tailnet source with 403', async () => {
	const res = await call({
		method: 'POST',
		url: '/review',
		remoteAddress: '203.0.113.9',
		authorization: `Bearer ${token}`,
		body: { pr_url: 'u' }
	});
	assert.equal(res.statusCode, 403);
});

test('protected route rejects a tailnet source without a token with 401', async () => {
	const res = await call({
		method: 'POST',
		url: '/review',
		remoteAddress: '100.64.0.5',
		body: { pr_url: 'u' }
	});
	assert.equal(res.statusCode, 401);
});

test('POST /review returns 202 with valid auth', async () => {
	const res = await call({
		method: 'POST',
		url: '/review',
		remoteAddress: '100.64.0.5',
		authorization: `Bearer ${token}`,
		body: { pr_url: 'https://github.com/o/r/pull/1' }
	});
	assert.equal(res.statusCode, 202);
	assert.equal(JSON.parse(res.body).reviewId, 'rid');
});

test('POST /review/cancel without reviewId returns 400', async () => {
	const res = await call({
		method: 'POST',
		url: '/review/cancel',
		remoteAddress: '100.64.0.5',
		authorization: `Bearer ${token}`,
		body: {}
	});
	assert.equal(res.statusCode, 400);
});

test('unknown route returns 404 (authed)', async () => {
	const res = await call({
		method: 'GET',
		url: '/nope',
		remoteAddress: '100.64.0.5',
		authorization: `Bearer ${token}`
	});
	assert.equal(res.statusCode, 404);
});

test('GET /logs/:id returns text/plain', async () => {
	const res = await call({
		method: 'GET',
		url: '/logs/rid?tail=50',
		remoteAddress: '100.64.0.5',
		authorization: `Bearer ${token}`
	});
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['Content-Type'], 'text/plain; charset=utf-8');
	assert.equal(res.body, 'logtext');
});
