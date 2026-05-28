// Reaper (Phase 3 daily log-prune) tests. selectContainersToPrune is pure, so the
// age / size / never-running rules are exercised directly; pruneReviewContainers
// is driven with a mock docker to assert the list query, removals, and that it
// stays best-effort under remove/list errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectContainersToPrune, pruneReviewContainers, startReaper } from '../src/reaper.js';

const NOW = 1_700_000_000_000;
const MB = 1024 * 1024;
const createdDaysAgo = (d) => Math.floor((NOW - d * 86400_000) / 1000); // unix seconds

test('age rule: prunes exited managed containers older than 7 days, keeps recent', () => {
	const ids = selectContainersToPrune(
		[
			{ Id: 'old', State: 'exited', Created: createdDaysAgo(8), SizeRw: 10 },
			{ Id: 'fresh', State: 'exited', Created: createdDaysAgo(2), SizeRw: 10 }
		],
		{ now: NOW }
	);
	assert.deepEqual(ids, ['old']);
});

test('never reaps non-finished states (running/created/paused/restarting/removing), even when old', () => {
	const ids = selectContainersToPrune(
		[
			{ Id: 'running', State: 'running', Created: createdDaysAgo(30), SizeRw: 10 },
			{ Id: 'created', State: 'created', Created: createdDaysAgo(30), SizeRw: 10 },
			{ Id: 'paused', State: 'paused', Created: createdDaysAgo(30), SizeRw: 10 },
			{ Id: 'restarting', State: 'restarting', Created: createdDaysAgo(30), SizeRw: 10 },
			{ Id: 'removing', State: 'removing', Created: createdDaysAgo(30), SizeRw: 10 }
		],
		{ now: NOW }
	);
	assert.deepEqual(ids, []);
});

test('size rule: over 100MB drops oldest survivors until under', () => {
	// three age-safe exited containers, 60MB each = 180MB > 100MB cap.
	const ids = selectContainersToPrune(
		[
			{ Id: 'a', State: 'exited', Created: createdDaysAgo(3), SizeRw: 60 * MB },
			{ Id: 'b', State: 'exited', Created: createdDaysAgo(2), SizeRw: 60 * MB },
			{ Id: 'c', State: 'exited', Created: createdDaysAgo(1), SizeRw: 60 * MB }
		],
		{ now: NOW }
	);
	// remove oldest a → 120MB still over; remove b → 60MB under; keep newest c.
	// Returned oldest-first (the documented contract) — no caller-side re-sort.
	assert.deepEqual(ids, ['a', 'b']);
});

test('under both thresholds: prunes nothing', () => {
	const ids = selectContainersToPrune(
		[{ Id: 'x', State: 'exited', Created: createdDaysAgo(1), SizeRw: 5 * MB }],
		{ now: NOW }
	);
	assert.deepEqual(ids, []);
});

test('pruneReviewContainers lists managed+size, removes the selected, tolerates a remove error', async () => {
	const removed = [];
	const docker = {
		listContainers: async (opts) => {
			assert.equal(opts.all, true);
			assert.equal(opts.size, true);
			assert.match(opts.label, /managed=true/);
			return [
				{ Id: 'old1', State: 'exited', Created: createdDaysAgo(10), SizeRw: 1 },
				{ Id: 'boom', State: 'exited', Created: createdDaysAgo(10), SizeRw: 1 },
				{ Id: 'keep', State: 'exited', Created: createdDaysAgo(1), SizeRw: 1 }
			];
		},
		removeContainer: async (id) => {
			if (id === 'boom') throw new Error('container busy');
			removed.push(id);
		}
	};
	const res = await pruneReviewContainers({ docker, now: NOW });
	assert.equal(res.candidates, 2); // old1 + boom (both >7d)
	assert.equal(res.removed, 1); // only old1 removed; boom threw but didn't crash
	assert.deepEqual(removed, ['old1']);
});

test('pruneReviewContainers is best-effort when Docker is unreachable', async () => {
	const docker = {
		listContainers: async () => {
			throw new Error('ECONNREFUSED');
		}
	};
	const res = await pruneReviewContainers({ docker, now: NOW });
	assert.deepEqual(res, { removed: 0, candidates: 0 });
});

test('startReaper fires the initial pass and stop() halts subsequent runs', async () => {
	let calls = 0;
	const docker = {
		listContainers: async () => {
			calls++;
			return [];
		},
		removeContainer: async () => {}
	};
	// initialDelayMs=5 so the initial pass fires fast; intervalMs=20 so the
	// recurring timer would otherwise tick during the post-stop wait — making
	// the second assertion meaningful (a missed clearInterval would increment).
	const stop = startReaper({ docker, initialDelayMs: 5, intervalMs: 20 });
	try {
		await new Promise((r) => setTimeout(r, 40));
		assert.ok(calls >= 1, 'reaper should run the initial pass');
		stop();
		const afterStop = calls;
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(calls, afterStop, 'reaper must not run after stop()');
	} finally {
		stop();
	}
});
