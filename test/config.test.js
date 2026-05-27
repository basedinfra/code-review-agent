import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostIdentity, loadConfig, resolveBindIp } from '../src/config.js';

test('resolveBindIp prefers an explicit AGENT_BIND_IP', () => {
	const r = resolveBindIp({ AGENT_BIND_IP: '127.0.0.1' }, {});
	assert.deepEqual(r, { bindIp: '127.0.0.1', explicit: true });
});

test('resolveBindIp auto-detects the tailnet interface', () => {
	const interfaces = {
		en0: [{ family: 'IPv4', address: '192.168.0.2', internal: false }],
		tailscale0: [{ family: 'IPv4', address: '100.71.2.3', internal: false }]
	};
	assert.deepEqual(resolveBindIp({}, interfaces), { bindIp: '100.71.2.3', explicit: false });
});

test('resolveBindIp returns null when no tailnet IP is present', () => {
	const interfaces = { en0: [{ family: 'IPv4', address: '192.168.0.2', internal: false }] };
	assert.deepEqual(resolveBindIp({}, interfaces), { bindIp: null, explicit: false });
});

test('hostIdentity maps platform/arch to the dashboard vocabulary', () => {
	assert.deepEqual(hostIdentity('darwin', 'arm64'), { host_os: 'darwin', host_arch: 'arm64' });
	assert.deepEqual(hostIdentity('linux', 'x64'), { host_os: 'linux', host_arch: 'x86_64' });
	assert.deepEqual(hostIdentity('win32', 'ia32'), { host_os: 'unknown', host_arch: 'unknown' });
});

test('loadConfig derives the register URL and applies defaults', () => {
	const config = loadConfig({
		AGENT_BIND_IP: '127.0.0.1',
		AGENT_VERSION: '9.9.9',
		DASHBOARD_URL: 'https://dash.example.com/'
	});
	assert.equal(config.registerUrl, 'https://dash.example.com/api/agents/code-review/register');
	assert.equal(config.port, 7777);
	assert.equal(config.maxConcurrentReviews, 3);
	assert.equal(config.prAgentPlatform, 'linux/amd64');
	assert.equal(config.dockerHost, 'tcp://socket-proxy:2375');
	assert.equal(config.agentVersion, '9.9.9');
	assert.equal(Object.isFrozen(config), true);
});

test('loadConfig honors an explicit REGISTER_URL override', () => {
	const config = loadConfig({
		AGENT_BIND_IP: '127.0.0.1',
		REGISTER_URL: 'https://custom/register',
		DASHBOARD_URL: 'https://dash.example.com'
	});
	assert.equal(config.registerUrl, 'https://custom/register');
});
