// Minimal Docker Engine API client speaking to a docker-socket-proxy over TCP.
//
// SECURITY: the agent NEVER mounts the raw /var/run/docker.sock — only the proxy
// container does, behind a CONTAINERS/IMAGES/POST/NETWORKS allowlist with
// EXEC=0. `DOCKER_HOST` points at the proxy (default tcp://socket-proxy:2375).
// Built on node:http so the runtime image carries zero dependencies.

import http from 'node:http';

// Default timeouts so a hung socket-proxy can never wedge the RPC server. Pulls
// get a generous window (amd64 PR-Agent under emulation is slow); container ops
// and log reads are quick. All overridable per call.
const DEFAULT_OP_TIMEOUT_MS = 30_000;
const DEFAULT_PULL_TIMEOUT_MS = 600_000;
const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;

export class DockerError extends Error {
	/**
	 * @param {string} message
	 * @param {number} [status]
	 */
	constructor(message, status) {
		super(message);
		this.name = 'DockerError';
		this.status = status;
	}
}

/**
 * Parse `tcp://host:port` (or `http://host:port`) into a connect target.
 *
 * @param {string} dockerHost
 * @returns {{ host: string, port: number }}
 */
export function parseDockerHost(dockerHost) {
	const m = /^(?:tcp|http):\/\/([^/:]+):(\d+)\/?$/.exec(dockerHost || '');
	if (!m) {
		throw new DockerError(`Unsupported DOCKER_HOST: ${dockerHost} (expected tcp://host:port)`);
	}
	return { host: m[1], port: Number(m[2]) };
}

/**
 * Split an image reference into the Engine API's `fromImage` + `tag`. Digest refs
 * (`name@sha256:…`) are passed whole as `fromImage` with no tag.
 *
 * @param {string} ref
 * @returns {{ fromImage: string, tag: string }}
 */
export function splitImageRef(ref) {
	if (ref.includes('@')) return { fromImage: ref, tag: '' };
	const lastColon = ref.lastIndexOf(':');
	const lastSlash = ref.lastIndexOf('/');
	if (lastColon > lastSlash) {
		return { fromImage: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
	}
	return { fromImage: ref, tag: 'latest' };
}

/**
 * Demultiplex a Docker log stream. Without a TTY, Docker frames stdout/stderr as
 * `[stream(1)][0,0,0][size(4, BE)][payload]`; with a TTY it is raw bytes. Tolerant:
 * if framing doesn't line up, the buffer is returned as raw UTF-8.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
export function demuxDockerStream(buf) {
	const parts = [];
	let i = 0;
	while (i + 8 <= buf.length) {
		const type = buf[i];
		if (type > 2) return buf.toString('utf8');
		const size = buf.readUInt32BE(i + 4);
		const start = i + 8;
		const end = start + size;
		if (end > buf.length) return buf.toString('utf8');
		parts.push(buf.toString('utf8', start, end));
		i = end;
	}
	if (i !== buf.length) {
		return parts.length ? parts.join('') + buf.toString('utf8', i) : buf.toString('utf8');
	}
	return parts.join('');
}

export class DockerClient {
	/**
	 * @param {string} dockerHost
	 */
	constructor(dockerHost) {
		this.endpoint = parseDockerHost(dockerHost);
	}

	/**
	 * Low-level request. Body (if any) is JSON-encoded; the response body is
	 * returned as a Buffer for binary-safe handling (log streams).
	 *
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, headers?: Record<string,string>, signal?: AbortSignal }} [opts]
	 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer }>}
	 */
	_raw(method, path, { body, headers = {}, signal, maxBytes } = {}) {
		return new Promise((resolve, reject) => {
			const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
			const req = http.request(
				{
					host: this.endpoint.host,
					port: this.endpoint.port,
					method,
					path,
					headers: {
						Host: 'docker',
						Accept: 'application/json',
						...(payload
							? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
							: {}),
						...headers
					},
					signal
				},
				(res) => {
					const chunks = [];
					let size = 0;
					res.on('data', (c) => {
						size += c.length;
						if (maxBytes && size > maxBytes) {
							res.destroy();
							reject(new DockerError(`response exceeded ${maxBytes} bytes for ${path}`));
							return;
						}
						chunks.push(c);
					});
					res.on('end', () =>
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body: Buffer.concat(chunks)
						})
					);
					// Without this, a mid-stream response error would hang the promise
					// until the AbortSignal timeout instead of rejecting promptly.
					res.on('error', reject);
				}
			);
			req.on('error', reject);
			if (payload) req.write(payload);
			req.end();
		});
	}

	/**
	 * Request expecting JSON. Throws DockerError on >= 400.
	 *
	 * @param {string} method
	 * @param {string} path
	 * @param {object} [opts]
	 * @returns {Promise<any>}
	 */
	async _json(method, path, opts) {
		const res = await this._raw(method, path, opts);
		const text = res.body.toString('utf8');
		if (res.status >= 400) {
			let msg = text;
			try {
				msg = JSON.parse(text).message || text;
			} catch {
				// non-JSON error body; use as-is
			}
			throw new DockerError(`Docker API ${method} ${path} → ${res.status}: ${msg}`, res.status);
		}
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/**
	 * Is the proxy/daemon reachable? Never throws (returns false on any error).
	 *
	 * @returns {Promise<boolean>}
	 */
	async ping() {
		try {
			const res = await this._raw('GET', '/_ping', { signal: AbortSignal.timeout(3000) });
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** @returns {Promise<any>} */
	version() {
		return this._json('GET', '/version', { signal: AbortSignal.timeout(3000) });
	}

	/** @returns {Promise<any>} */
	info() {
		return this._json('GET', '/info', { signal: AbortSignal.timeout(5000) });
	}

	/**
	 * Pull an image. The pull response is a JSONL progress stream; an `error`
	 * line means failure even on a 200 status.
	 *
	 * @param {string} ref
	 * @param {{ platform?: string, signal?: AbortSignal }} [opts]
	 * @returns {Promise<boolean>}
	 */
	async pullImage(ref, { platform, signal = AbortSignal.timeout(DEFAULT_PULL_TIMEOUT_MS) } = {}) {
		const { fromImage, tag } = splitImageRef(ref);
		const qs = new URLSearchParams({ fromImage });
		if (tag) qs.set('tag', tag);
		if (platform) qs.set('platform', platform);
		const res = await this._raw('POST', `/images/create?${qs}`, {
			signal,
			maxBytes: DEFAULT_LOG_MAX_BYTES
		});
		const text = res.body.toString('utf8');
		if (res.status >= 400)
			throw new DockerError(`pull ${ref} → ${res.status}: ${text}`, res.status);
		for (const line of text.split('\n')) {
			const t = line.trim();
			if (!t) continue;
			try {
				const obj = JSON.parse(t);
				if (obj.error) throw new DockerError(`pull ${ref}: ${obj.error}`);
			} catch (e) {
				if (e instanceof DockerError) throw e;
				// ignore non-JSON progress noise
			}
		}
		return true;
	}

	/**
	 * @param {string} name
	 * @param {object} config Engine API container-create config
	 * @param {{ platform?: string }} [opts]
	 * @returns {Promise<{ Id: string }>}
	 */
	createContainer(
		name,
		config,
		{ platform, signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) } = {}
	) {
		const qs = new URLSearchParams();
		if (name) qs.set('name', name);
		if (platform) qs.set('platform', platform);
		const q = qs.toString();
		return this._json('POST', `/containers/create${q ? `?${q}` : ''}`, { body: config, signal });
	}

	/** @param {string} id @param {{ signal?: AbortSignal }} [opts] */
	startContainer(id, { signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) } = {}) {
		return this._json('POST', `/containers/${encodeURIComponent(id)}/start`, { signal });
	}

	/**
	 * Stop a container. 204 (stopped) / 304 (already stopped) / 404 (already
	 * gone) are success; any other status throws so a failed stop is never
	 * mistaken for success.
	 *
	 * @param {string} id @param {{ t?: number, signal?: AbortSignal }} [opts]
	 */
	async stopContainer(id, { t = 10, signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) } = {}) {
		const res = await this._raw('POST', `/containers/${encodeURIComponent(id)}/stop?t=${t}`, {
			signal
		});
		if (![204, 304, 404].includes(res.status)) {
			throw new DockerError(`stop ${id} → ${res.status}: ${res.body.toString('utf8')}`, res.status);
		}
		return res;
	}

	/**
	 * Remove a container. 204 (removed) / 404 (already gone) are success; any
	 * other status (403/409/500) throws — a caller must NOT evict its record
	 * while the container is still alive.
	 *
	 * @param {string} id @param {{ force?: boolean, v?: boolean, signal?: AbortSignal }} [opts]
	 */
	async removeContainer(
		id,
		{ force = true, v = true, signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) } = {}
	) {
		const res = await this._raw(
			'DELETE',
			`/containers/${encodeURIComponent(id)}?force=${force}&v=${v}`,
			{ signal }
		);
		if (![204, 404].includes(res.status)) {
			throw new DockerError(
				`remove ${id} → ${res.status}: ${res.body.toString('utf8')}`,
				res.status
			);
		}
		return res;
	}

	/** @param {string} id */
	inspectContainer(id, { signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) } = {}) {
		return this._json('GET', `/containers/${encodeURIComponent(id)}/json`, { signal });
	}

	/**
	 * @param {{ all?: boolean, label?: string, signal?: AbortSignal }} [opts]
	 * @returns {Promise<Array<{ Id: string }>>}
	 */
	listContainers({ all = true, label, signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS) } = {}) {
		const qs = new URLSearchParams({ all: String(all) });
		if (label) qs.set('filters', JSON.stringify({ label: [label] }));
		return this._json('GET', `/containers/json?${qs}`, { signal });
	}

	/**
	 * Collect demultiplexed container logs as a string. The body is capped
	 * (`maxBytes`) so a runaway container can't exhaust the agent's memory; the
	 * `tail` line-limit is the primary bound for normal use.
	 *
	 * @param {string} id
	 * @param {{ stdout?: boolean, stderr?: boolean, tail?: number | string, since?: number, maxBytes?: number, signal?: AbortSignal }} [opts]
	 * @returns {Promise<string>}
	 */
	async collectLogs(
		id,
		{
			stdout = true,
			stderr = true,
			tail = 'all',
			since,
			maxBytes = DEFAULT_LOG_MAX_BYTES,
			signal = AbortSignal.timeout(DEFAULT_OP_TIMEOUT_MS)
		} = {}
	) {
		const qs = new URLSearchParams({
			stdout: String(stdout),
			stderr: String(stderr),
			tail: String(tail)
		});
		if (since) qs.set('since', String(since));
		const res = await this._raw('GET', `/containers/${encodeURIComponent(id)}/logs?${qs}`, {
			maxBytes,
			signal
		});
		if (res.status >= 400) {
			throw new DockerError(`logs ${id} → ${res.status}: ${res.body.toString('utf8')}`, res.status);
		}
		return demuxDockerStream(res.body);
	}
}
