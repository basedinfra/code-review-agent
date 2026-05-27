import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reviews } from '../src/reviews.js';

function fakeDocker({ listResult = [], logsResult = 'LOGS', pullThrows = false } = {}) {
	let n = 0;
	const calls = { pull: [], create: [], start: [], stop: [], remove: [], list: [], logs: [] };
	return {
		calls,
		async pullImage(ref, opts) {
			calls.pull.push({ ref, opts });
			if (pullThrows) throw new Error('pull boom');
		},
		async createContainer(name, config, opts) {
			calls.create.push({ name, config, opts });
			return { Id: `cid-${++n}` };
		},
		async startContainer(id) {
			calls.start.push(id);
		},
		async stopContainer(id, opts) {
			calls.stop.push({ id, opts });
		},
		async removeContainer(id, opts) {
			calls.remove.push({ id, opts });
		},
		async listContainers(opts) {
			calls.list.push(opts);
			return listResult;
		},
		async collectLogs(id, opts) {
			calls.logs.push({ id, opts });
			return logsResult;
		}
	};
}

const baseConfig = {
	prAgentImage: 'codiumai/pr-agent:latest',
	prAgentPlatform: 'linux/amd64',
	prAgentMemory: '2g',
	prAgentNetwork: null,
	maxConcurrentReviews: 3
};

test('start rejects without pr_url (400)', async () => {
	const reviews = new Reviews({ docker: fakeDocker(), config: baseConfig });
	await assert.rejects(
		() => reviews.start({}),
		(e) => e.status === 400
	);
});

test('start runs an ephemeral container with keys in env, labels, memory, platform', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: baseConfig });
	const r = await reviews.start({
		pr_url: 'https://github.com/o/r/pull/1',
		provider_keys: { openai: 'sk-o' }
	});
	assert.equal(r.status, 'running');
	assert.match(r.reviewId, /^[0-9a-f-]{36}$/);
	assert.equal(reviews.inFlight, 1);
	assert.equal(docker.calls.create.length, 1);
	assert.equal(docker.calls.start.length, 1);
	const created = docker.calls.create[0];
	assert.equal(created.opts.platform, 'linux/amd64');
	assert.ok(created.name.startsWith('cr-review-'));
	// Keys travel via container Env, never a disk file.
	assert.ok(created.config.Env.includes('OPENAI.KEY=sk-o'));
	assert.equal(created.config.HostConfig.Memory, 2 * 1024 ** 3);
	assert.equal(created.config.Labels['baseinfra.code-review.review-id'], r.reviewId);
});

test('start pulls the image at most once per process', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: baseConfig });
	await reviews.start({ pr_url: 'u' });
	await reviews.start({ pr_url: 'u' });
	assert.equal(docker.calls.pull.length, 1);
});

test('start enforces the concurrency cap with 429', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: { ...baseConfig, maxConcurrentReviews: 1 } });
	await reviews.start({ pr_url: 'u' });
	await assert.rejects(
		() => reviews.start({ pr_url: 'u' }),
		(e) => e.status === 429
	);
});

test('cancel stops+removes, decrements inFlight, and evicts (idempotent → 404)', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: baseConfig });
	const r = await reviews.start({ pr_url: 'u' });
	const res = await reviews.cancel(r.reviewId);
	assert.equal(res.status, 'cancelled');
	assert.equal(reviews.inFlight, 0);
	assert.equal(docker.calls.stop.length, 1);
	assert.equal(docker.calls.remove.length, 1);
	await assert.rejects(
		() => reviews.cancel(r.reviewId),
		(e) => e.status === 404
	);
});

test('cancel resolves a container by label after an agent restart', async () => {
	const docker = fakeDocker({ listResult: [{ Id: 'orphan-cid' }] });
	const reviews = new Reviews({ docker, config: baseConfig });
	await reviews.cancel('11111111-1111-1111-1111-111111111111');
	assert.deepEqual(
		docker.calls.remove.map((c) => c.id),
		['orphan-cid']
	);
});

test('logs returns container output; unknown review → 404', async () => {
	const docker = fakeDocker({ listResult: [{ Id: 'cid-x' }], logsResult: 'hello logs' });
	const reviews = new Reviews({ docker, config: baseConfig });
	assert.equal(await reviews.logs('some-id'), 'hello logs');

	const empty = new Reviews({ docker: fakeDocker({ listResult: [] }), config: baseConfig });
	await assert.rejects(
		() => empty.logs('missing'),
		(e) => e.status === 404
	);
});

test('start tolerates a pull failure when the image is cached', async () => {
	const docker = fakeDocker({ pullThrows: true });
	const reviews = new Reviews({ docker, config: baseConfig });
	const r = await reviews.start({ pr_url: 'u' });
	assert.equal(r.status, 'running');
	assert.equal(docker.calls.create.length, 1);
});
