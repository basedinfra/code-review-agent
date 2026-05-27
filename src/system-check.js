// First-run system check. Surfaces resource/runtime problems as `warnings`
// (carried in the register body, also shown via /health) WITHOUT refusing to
// start — a too-small machine pairs anyway and gets a UI badge (Sprint 6).

import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { isTailnetIp } from './net.js';

export const THRESHOLDS = {
	ramTotalGb: 8,
	ramFreeGb: 4,
	diskFreeGb: 10
};

export const GB = 1024 ** 3;

function round1(n) {
	return Math.round(n * 10) / 10;
}

/**
 * Pure resource → warnings evaluation (no os calls), so thresholds are testable.
 *
 * @param {{ totalBytes: number, freeBytes: number, diskFreeBytes: number | null }} m
 * @returns {Array<object>}
 */
export function evaluateResources({ totalBytes, freeBytes, diskFreeBytes }) {
	const ramTotalGb = totalBytes / GB;
	const ramFreeGb = freeBytes / GB;
	const diskFreeGb = diskFreeBytes == null ? null : diskFreeBytes / GB;
	const reasons = [];
	if (ramTotalGb < THRESHOLDS.ramTotalGb) reasons.push('ram_total');
	if (ramFreeGb < THRESHOLDS.ramFreeGb) reasons.push('ram_free');
	if (diskFreeGb != null && diskFreeGb < THRESHOLDS.diskFreeGb) reasons.push('disk_free');
	if (reasons.length === 0) return [];
	return [
		{
			kind: 'low_resources',
			reasons,
			ram_total_gb: round1(ramTotalGb),
			ram_free_gb: round1(ramFreeGb),
			disk_free_gb: diskFreeGb == null ? null : round1(diskFreeGb),
			thresholds: THRESHOLDS
		}
	];
}

/**
 * Best-effort container-runtime detection from `docker info`.
 *
 * @param {any} info
 * @returns {string} orbstack | docker-desktop | colima | docker-engine | unknown
 */
export function detectRuntimeKind(info) {
	const haystack = `${info?.Name ?? ''} ${info?.OperatingSystem ?? ''} ${info?.ServerVersion ?? ''}`
		.toLowerCase()
		.trim();
	if (haystack.includes('orbstack')) return 'orbstack';
	if (haystack.includes('docker desktop') || haystack.includes('docker-desktop')) {
		return 'docker-desktop';
	}
	if (haystack.includes('colima')) return 'colima';
	return haystack ? 'docker-engine' : 'unknown';
}

async function safe(fn, fallback) {
	try {
		return await fn();
	} catch {
		return fallback;
	}
}

/**
 * Run all first-run checks. Never throws.
 *
 * @param {{ docker: import('./docker-client.js').DockerClient, config: object }} deps
 * @returns {Promise<{ checks: object, warnings: Array<object> }>}
 */
export async function runSystemCheck({ docker, config }) {
	const warnings = [];

	const dockerReachable = await safe(() => docker.ping(), false);
	let runtimeKind = 'unknown';
	if (dockerReachable) {
		runtimeKind = detectRuntimeKind(await safe(() => docker.info(), null));
	} else {
		warnings.push({ kind: 'docker_unreachable', docker_host: config.dockerHost });
	}

	const totalBytes = os.totalmem();
	const freeBytes = os.freemem();
	const diskFreeBytes = await safe(async () => {
		const s = await statfs('/');
		return s.bavail * s.bsize;
	}, null);
	warnings.push(...evaluateResources({ totalBytes, freeBytes, diskFreeBytes }));

	const tailnetUp = Boolean(config.bindIp && isTailnetIp(config.bindIp));
	if (!tailnetUp) warnings.push({ kind: 'tailscale_down' });

	return {
		checks: {
			docker_reachable: dockerReachable,
			runtime_kind: runtimeKind,
			ram_total_gb: round1(totalBytes / GB),
			ram_free_gb: round1(freeBytes / GB),
			disk_free_gb: diskFreeBytes == null ? null : round1(diskFreeBytes / GB),
			tailnet_up: tailnetUp,
			bind_ip: config.bindIp
		},
		warnings
	};
}
