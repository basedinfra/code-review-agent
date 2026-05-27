import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntimeKind, evaluateResources, GB, THRESHOLDS } from '../src/system-check.js';

test('evaluateResources returns no warning when above all thresholds', () => {
	const warnings = evaluateResources({
		totalBytes: 16 * GB,
		freeBytes: 8 * GB,
		diskFreeBytes: 100 * GB
	});
	assert.deepEqual(warnings, []);
});

test('evaluateResources flags low_resources with reasons + numbers', () => {
	const warnings = evaluateResources({
		totalBytes: 4 * GB,
		freeBytes: 1 * GB,
		diskFreeBytes: 5 * GB
	});
	assert.equal(warnings.length, 1);
	const w = warnings[0];
	assert.equal(w.kind, 'low_resources');
	assert.deepEqual(w.reasons.sort(), ['disk_free', 'ram_free', 'ram_total']);
	assert.equal(w.ram_total_gb, 4);
	assert.equal(w.ram_free_gb, 1);
	assert.equal(w.disk_free_gb, 5);
	assert.deepEqual(w.thresholds, THRESHOLDS);
});

test('evaluateResources tolerates an unknown disk reading', () => {
	const warnings = evaluateResources({
		totalBytes: 16 * GB,
		freeBytes: 8 * GB,
		diskFreeBytes: null
	});
	assert.deepEqual(warnings, []);
	const low = evaluateResources({ totalBytes: 2 * GB, freeBytes: 1 * GB, diskFreeBytes: null });
	assert.equal(low[0].disk_free_gb, null);
	assert.ok(!low[0].reasons.includes('disk_free'));
});

test('detectRuntimeKind classifies common runtimes', () => {
	assert.equal(detectRuntimeKind({ Name: 'orbstack' }), 'orbstack');
	assert.equal(detectRuntimeKind({ OperatingSystem: 'Docker Desktop' }), 'docker-desktop');
	assert.equal(detectRuntimeKind({ Name: 'colima' }), 'colima');
	assert.equal(detectRuntimeKind({ OperatingSystem: 'Ubuntu 22.04' }), 'docker-engine');
	assert.equal(detectRuntimeKind(null), 'unknown');
	assert.equal(detectRuntimeKind({}), 'unknown');
});
