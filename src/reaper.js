// Phase 3 "reaper": review containers are kept after exit so /logs/:id can read
// results (see pragent.js — AutoRemove:false), so they accumulate on the BYO
// machine's disk. A daily pass removes the agent's own COMPLETED review
// containers that are old (>7 days) or, oldest-first, once their writable-layer
// total exceeds 100 MB. A running review is never touched.

import { LABEL_MANAGED } from './reviews.js';

export const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const PRUNE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
export const INITIAL_DELAY_MS = 60 * 1000; // first pass ~1 min after boot

const NOOP_LOG = () => {};

// Only reap containers that have finished. A managed review container is
// created→started in one shot (force-removed on a failed start) and cancel()
// removes immediately, so an EXITED/DEAD managed container is a completed review
// whose results are being retained for /logs/:id. We skip `running` (in-flight)
// and also `created`/`paused`/`restarting`/`removing` (transient or mid-teardown
// — leave those for the next pass rather than racing a concurrent operation).
const REAPABLE_STATES = new Set(['exited', 'dead']);

/**
 * Pick which managed containers to prune, oldest-first. Pure (no I/O) for tests.
 *
 * `Created` is Docker's unix-seconds *creation* time, used as the prune clock. For
 * these containers it's an accurate proxy for finish time: a PR-Agent review is
 * short-lived (minutes) and a still-running one is excluded by REAPABLE_STATES, so
 * created ≈ finished to within the review's runtime — negligible against a 7-day
 * threshold checked once a day. (`State.FinishedAt` is exact but costs a
 * per-container inspect; not worth it for a daily sweep.)
 *
 * `SizeRw` is the writable-layer delta — the shared base image is excluded (Docker
 * counts it once, not per container) — and requires the list call's `size=true`.
 * Reclaimed bytes may differ slightly on non-overlay2 storage drivers.
 *
 * @param {Array<{ Id: string, State?: string, Created?: number, SizeRw?: number }>} containers
 * @param {{ now?: number, maxAgeMs?: number, maxBytes?: number }} [opts]
 * @returns {string[]} container ids to remove, oldest-first
 */
export function selectContainersToPrune(
	containers,
	{ now = Date.now(), maxAgeMs = PRUNE_MAX_AGE_MS, maxBytes = PRUNE_MAX_BYTES } = {}
) {
	const reapable = (Array.isArray(containers) ? containers : [])
		.filter((c) => REAPABLE_STATES.has(String(c.State || '').toLowerCase()))
		.map((c) => ({ id: c.Id, createdMs: (c.Created || 0) * 1000, sizeRw: c.SizeRw || 0 }))
		.sort((a, b) => a.createdMs - b.createdMs); // oldest first

	const remove = new Set();
	// Age rule: anything created (≈ finished) more than maxAgeMs ago.
	for (const c of reapable) {
		if (now - c.createdMs > maxAgeMs) remove.add(c.id);
	}
	// Size rule: if the survivors' writable layers still exceed the cap, drop the
	// oldest survivors until under it.
	let total = reapable.reduce((sum, c) => (remove.has(c.id) ? sum : sum + c.sizeRw), 0);
	for (const c of reapable) {
		if (total <= maxBytes) break;
		if (remove.has(c.id)) continue;
		remove.add(c.id);
		total -= c.sizeRw;
	}
	// reapable is sorted oldest-first and Set preserves insertion order, so the
	// returned ids are oldest-first.
	return [...remove];
}

/**
 * Run one prune pass against Docker. Best-effort: a Docker error or a single
 * failed removal is logged, never thrown — the reaper must not crash the agent.
 *
 * @param {{ docker: import('./docker-client.js').DockerClient, log?: (m: string) => void, now?: number }} deps
 * @returns {Promise<{ removed: number, candidates: number }>}
 */
export async function pruneReviewContainers({ docker, log = NOOP_LOG, now = Date.now() } = {}) {
	let containers;
	try {
		containers = await docker.listContainers({
			all: true,
			label: `${LABEL_MANAGED}=true`,
			size: true
		});
	} catch (e) {
		log(`prune skipped: cannot list containers (${e.message})`);
		return { removed: 0, candidates: 0 };
	}
	const ids = selectContainersToPrune(containers, { now });
	let removed = 0;
	for (const id of ids) {
		try {
			await docker.removeContainer(id, { force: true, v: true });
			removed++;
		} catch (e) {
			log(`prune: could not remove ${String(id).slice(0, 12)} (${e.message})`);
		}
	}
	if (removed) log(`prune: removed ${removed} old review container(s)`);
	return { removed, candidates: ids.length };
}

/**
 * Start the daily reaper: first pass ~`initialDelayMs` after boot, then every
 * `intervalMs`. Returns a stop() that clears both timers. The timers are unref'd,
 * so the reaper never keeps the process alive on its own.
 *
 * @param {{ docker: object, log?: (m: string) => void, intervalMs?: number, initialDelayMs?: number }} deps
 * @returns {() => void} stop
 */
export function startReaper({
	docker,
	log = NOOP_LOG,
	intervalMs = PRUNE_INTERVAL_MS,
	initialDelayMs = INITIAL_DELAY_MS
} = {}) {
	const tick = () => {
		pruneReviewContainers({ docker, log }).catch((e) => log(`prune error: ${e.message}`));
	};
	const initial = setTimeout(tick, initialDelayMs);
	const timer = setInterval(tick, intervalMs);
	initial.unref?.();
	timer.unref?.();
	return () => {
		clearTimeout(initial);
		clearInterval(timer);
	};
}
