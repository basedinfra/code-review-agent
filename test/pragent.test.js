import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildPrAgentCreateConfig,
	buildPrAgentEnv,
	defaultPrAgentCmd,
	parseMemoryToBytes
} from '../src/pragent.js';

test('buildPrAgentEnv emits dot-style keys, only for supplied values', () => {
	const env = buildPrAgentEnv({
		providerKeys: { openai: 'sk-o', anthropic: 'sk-a', gemini: 'g-key' },
		githubToken: 'ghp_x'
	});
	assert.ok(env.includes('CONFIG.GIT_PROVIDER=github'));
	assert.ok(env.includes('GITHUB.DEPLOYMENT_TYPE=user'));
	assert.ok(env.includes('OPENAI.KEY=sk-o'));
	assert.ok(env.includes('ANTHROPIC.KEY=sk-a'));
	assert.ok(env.includes('GOOGLE_AI_STUDIO.GEMINI_API_KEY=g-key'));
	assert.ok(env.includes('GITHUB.USER_TOKEN=ghp_x'));
});

test('buildPrAgentEnv omits absent providers and adds optional model/effort', () => {
	const env = buildPrAgentEnv({
		providerKeys: { openai: 'sk-o' },
		model: 'openai/gpt-x',
		reasoningEffort: 'high'
	});
	assert.ok(env.some((e) => e.startsWith('OPENAI.KEY=')));
	assert.ok(!env.some((e) => e.startsWith('ANTHROPIC.KEY=')));
	assert.ok(!env.some((e) => e.startsWith('GOOGLE_AI_STUDIO.GEMINI_API_KEY=')));
	assert.ok(env.includes('CONFIG.MODEL=openai/gpt-x'));
	assert.ok(env.includes('CONFIG.MODEL_TURBO=openai/gpt-x'));
	assert.ok(env.includes('CONFIG.REASONING_EFFORT=high'));
});

test("buildPrAgentEnv ignores reasoningEffort='none'", () => {
	const env = buildPrAgentEnv({ providerKeys: {}, reasoningEffort: 'none' });
	assert.ok(!env.some((e) => e.startsWith('CONFIG.REASONING_EFFORT=')));
});

test('github token can come from providerKeys.github', () => {
	const env = buildPrAgentEnv({ providerKeys: { github: 'ghp_y' } });
	assert.ok(env.includes('GITHUB.USER_TOKEN=ghp_y'));
});

test('parseMemoryToBytes parses docker-style sizes', () => {
	assert.equal(parseMemoryToBytes('2g'), 2 * 1024 ** 3);
	assert.equal(parseMemoryToBytes('512m'), 512 * 1024 ** 2);
	assert.equal(parseMemoryToBytes('1024'), 1024);
	assert.equal(parseMemoryToBytes(2048), 2048);
	assert.equal(parseMemoryToBytes('garbage'), 0);
});

test('buildPrAgentCreateConfig carries keys in Env (not a disk file) and sets limits + labels', () => {
	const env = buildPrAgentEnv({ providerKeys: { openai: 'sk-o' } });
	const config = buildPrAgentCreateConfig({
		image: 'codiumai/pr-agent:latest',
		env,
		cmd: defaultPrAgentCmd('/review', 'https://github.com/o/r/pull/1'),
		memoryBytes: parseMemoryToBytes('2g'),
		networkMode: 'bridge',
		labels: { 'baseinfra.code-review.review-id': 'abc' }
	});
	assert.equal(config.Image, 'codiumai/pr-agent:latest');
	// Secrets travel via Env (transient container state), never an --env-file on disk.
	assert.ok(config.Env.includes('OPENAI.KEY=sk-o'));
	assert.equal(config.HostConfig.Memory, 2 * 1024 ** 3);
	assert.equal(config.HostConfig.AutoRemove, false);
	assert.equal(config.HostConfig.NetworkMode, 'bridge');
	assert.deepEqual(config.Cmd, ['--pr_url', 'https://github.com/o/r/pull/1', 'review']);
	assert.equal(config.Labels['baseinfra.code-review.review-id'], 'abc');
});

test('defaultPrAgentCmd strips the leading slash from the command', () => {
	assert.deepEqual(defaultPrAgentCmd('/improve', 'URL'), ['--pr_url', 'URL', 'improve']);
	assert.deepEqual(defaultPrAgentCmd(undefined, 'URL'), ['--pr_url', 'URL', 'review']);
});
