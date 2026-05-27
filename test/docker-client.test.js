import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DockerError,
	demuxDockerStream,
	parseDockerHost,
	splitImageRef
} from '../src/docker-client.js';

test('parseDockerHost handles tcp:// and http://', () => {
	assert.deepEqual(parseDockerHost('tcp://socket-proxy:2375'), {
		host: 'socket-proxy',
		port: 2375
	});
	assert.deepEqual(parseDockerHost('http://127.0.0.1:2375'), { host: '127.0.0.1', port: 2375 });
});

test('parseDockerHost rejects unsupported schemes', () => {
	assert.throws(() => parseDockerHost('unix:///var/run/docker.sock'), DockerError);
	assert.throws(() => parseDockerHost(''), DockerError);
});

test('splitImageRef separates tag, digest, and registry-port forms', () => {
	assert.deepEqual(splitImageRef('codiumai/pr-agent:latest'), {
		fromImage: 'codiumai/pr-agent',
		tag: 'latest'
	});
	assert.deepEqual(splitImageRef('codiumai/pr-agent'), {
		fromImage: 'codiumai/pr-agent',
		tag: 'latest'
	});
	assert.deepEqual(splitImageRef('ghcr.io/basedinfra/code-review-agent:v1'), {
		fromImage: 'ghcr.io/basedinfra/code-review-agent',
		tag: 'v1'
	});
	// registry with a port but no tag → must not split the port as a tag
	assert.deepEqual(splitImageRef('registry:5000/img'), {
		fromImage: 'registry:5000/img',
		tag: 'latest'
	});
	assert.deepEqual(splitImageRef('registry:5000/img:v2'), {
		fromImage: 'registry:5000/img',
		tag: 'v2'
	});
	// digest → whole ref as fromImage, no tag
	assert.deepEqual(splitImageRef('img@sha256:abc123'), { fromImage: 'img@sha256:abc123', tag: '' });
});

function frame(streamType, text) {
	const payload = Buffer.from(text, 'utf8');
	const header = Buffer.alloc(8);
	header[0] = streamType;
	header.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, payload]);
}

test('demuxDockerStream concatenates multiplexed stdout/stderr frames', () => {
	const buf = Buffer.concat([frame(1, 'hello '), frame(2, 'world')]);
	assert.equal(demuxDockerStream(buf), 'hello world');
});

test('demuxDockerStream falls back to raw bytes for TTY/unframed streams', () => {
	assert.equal(demuxDockerStream(Buffer.from('plain TTY output', 'utf8')), 'plain TTY output');
});
