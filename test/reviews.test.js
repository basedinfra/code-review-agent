import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reviews } from '../src/reviews.js';

// Stateful fake Docker: tracks container lifecycle so the Docker-authoritative
// concurrency gate can be exercised realistically. listContainers({all:false})
// returns only 'running' containers, matching the real Engine API.
function fakeDocker({
	logsResult = 'LOGS',
	pullThrows = false,
	startThrows = false,
	removeThrows = false
} = {}) {
	let n = 0;
	const containers = new Map(); // id → { state, labels }
	const calls = { pull: [], create: [], start: [], stop: [], remove: [], list: [], logs: [] };
	return {
		calls,
		containers,
		async pullImage(ref, opts) {
			calls.pull.push({ ref, opts });
			if (pullThrows) throw new Error('pull boom');
		},
		async createContainer(name, config, opts) {
			calls.create.push({ name, config, opts });
			const Id = `cid-${++n}`;
			containers.set(Id, { state: 'created', labels: config.Labels || {} });
			return { Id };
		},
		async startContainer(id) {
			calls.start.push(id);
			if (startThrows) throw new Error('start boom');
			const c = containers.get(id);
			if (c) c.state = 'running';
		},
		async stopContainer(id, opts) {
			calls.stop.push({ id, opts });
		},
		async removeContainer(id, opts) {
			calls.remove.push({ id, opts });
			if (removeThrows) throw new Error('remove boom');
			containers.delete(id);
		},
		async listContainers({ all = true, label } = {}) {
			calls.list.push({ all, label });
			let entries = [...containers.entries()];
			if (label && label.includes('=')) {
				const [k, v] = label.split('=');
				entries = entries.filter(([, c]) => c.labels[k] === v);
			}
			if (all === false) entries = entries.filter(([, c]) => c.state === 'running');
			return entries.map(([Id]) => ({ Id }));
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
	assert.equal(docker.calls.create.length, 1);
	assert.equal(docker.calls.start.length, 1);
	const created = docker.calls.create[0];
	assert.equal(created.opts.platform, 'linux/amd64');
	assert.ok(created.name.startsWith('cr-review-'));
	assert.ok(created.config.Env.includes('OPENAI.KEY=sk-o')); // keys via env, not disk
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

test('concurrency cap is Docker-authoritative and self-heals', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: { ...baseConfig, maxConcurrentReviews: 1 } });
	const r1 = await reviews.start({ pr_url: 'u' });
	await assert.rejects(
		() => reviews.start({ pr_url: 'u' }),
		(e) => e.status === 429
	);
	// cancel frees the slot
	await reviews.cancel(r1.reviewId);
	const r2 = await reviews.start({ pr_url: 'u' });
	assert.equal(r2.status, 'running');
});

test('a COMPLETED container frees its slot (no permanent 429 — the P1 fix)', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: { ...baseConfig, maxConcurrentReviews: 1 } });
	const r1 = await reviews.start({ pr_url: 'u' });
	// Simulate the PR-Agent container exiting normally (not cancelled):
	docker.containers.get(r1.containerId).state = 'exited';
	// runningCount() counts only 'running', so the slot is free again.
	const r2 = await reviews.start({ pr_url: 'u' });
	assert.equal(r2.status, 'running');
});

test('cancel stops + removes the container and evicts the record', async () => {
	const docker = fakeDocker();
	const reviews = new Reviews({ docker, config: baseConfig });
	const r = await reviews.start({ pr_url: 'u' });
	const res = await reviews.cancel(r.reviewId);
	assert.equal(res.status, 'cancelled');
	assert.equal(docker.calls.stop.length, 1);
	assert.equal(docker.calls.remove.length, 1);
	assert.equal(docker.containers.has(r.containerId), false);
});

test('cancel does NOT evict the record when removal fails', async () => {
	const docker = fakeDocker({ removeThrows: true });
	const reviews = new Reviews({ docker, config: baseConfig });
	const r = await reviews.start({ pr_url: 'u' });
	await assert.rejects(() => reviews.cancel(r.reviewId)); // removeContainer throws
	assert.equal(reviews.active.has(r.reviewId), true); // still tracked → retriable
});

test('start removes the created container if startContainer fails', async () => {
	const docker = fakeDocker({ startThrows: true });
	const reviews = new Reviews({ docker, config: baseConfig });
	await assert.rejects(() => reviews.start({ pr_url: 'u' }));
	assert.equal(docker.calls.remove.length, 1); // orphan cleaned up
});

test('cancel resolves a container by label after an agent restart', async () => {
	const docker = fakeDocker();
	// Seed a managed container that isn't in the in-memory map (simulating a restart).
	docker.containers.set('orphan-cid', {
		state: 'running',
		labels: { 'baseinfra.code-review.review-id': '11111111-1111-1111-1111-111111111111' }
	});
	const reviews = new Reviews({ docker, config: baseConfig });
	await reviews.cancel('11111111-1111-1111-1111-111111111111');
	assert.deepEqual(
		docker.calls.remove.map((c) => c.id),
		['orphan-cid']
	);
});

test('logs returns container output; unknown review → 404', async () => {
	const docker = fakeDocker({ logsResult: 'hello logs' });
	docker.containers.set('cid-x', {
		state: 'running',
		labels: { 'baseinfra.code-review.review-id': 'some-id' }
	});
	const reviews = new Reviews({ docker, config: baseConfig });
	assert.equal(await reviews.logs('some-id'), 'hello logs');

	const empty = new Reviews({ docker: fakeDocker(), config: baseConfig });
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
