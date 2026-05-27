// The agent's HTTP RPC surface (node:http). index.js binds the returned listener
// to the tailnet IP. /health is open (installer + UI probe); everything else
// passes the tailnet-source + Bearer gate in auth.js.

import { authorize } from './auth.js';
import { buildHealth } from './health.js';
import { runSystemCheck } from './system-check.js';
import { HttpStatusError } from './errors.js';
import { DEFAULT_LOG_TAIL } from './reviews.js';

const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const MAX_LOG_TAIL = 10000;

function sendJson(res, status, obj) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(obj));
}

/**
 * Clamp the `tail` query param to a positive integer ≤ MAX_LOG_TAIL. Guards
 * against `?tail=-100` (which `Number(x) || DEFAULT` would let through, since
 * `-100 || 1000 === -100`) and absurdly large values.
 *
 * @param {string | null} raw
 * @returns {number}
 */
function parseTail(raw) {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LOG_TAIL) : DEFAULT_LOG_TAIL;
}

/**
 * Read + JSON-parse a request body with a size cap.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new HttpStatusError(413, 'request body too large'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new HttpStatusError(400, 'invalid JSON body'));
			}
		});
		req.on('error', reject);
	});
}

/**
 * @param {{
 *   config: object,
 *   reviews: import('./reviews.js').Reviews,
 *   docker: import('./docker-client.js').DockerClient,
 *   startedAt?: number,
 *   log?: (m: string) => void
 * }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRequestListener({
	config,
	reviews,
	docker,
	startedAt = Date.now(),
	log = () => {}
}) {
	return async function handler(req, res) {
		try {
			const url = new URL(req.url ?? '/', 'http://agent');
			const path = url.pathname;
			const method = req.method;

			if (method === 'GET' && path === '/health') {
				const systemCheck = await runSystemCheck({ docker, config });
				return sendJson(res, 200, buildHealth({ systemCheck, config, startedAt }));
			}

			const auth = authorize(req, { allowLoopback: config.allowLoopback });
			if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });

			if (method === 'POST' && path === '/pull-images') {
				return sendJson(res, 200, { ok: true, ...(await reviews.pullImage()) });
			}
			if (method === 'POST' && path === '/review') {
				return sendJson(res, 202, await reviews.start(await readJson(req)));
			}
			if (method === 'POST' && path === '/review/cancel') {
				const body = await readJson(req);
				if (!body?.reviewId) throw new HttpStatusError(400, 'reviewId is required');
				return sendJson(res, 200, await reviews.cancel(body.reviewId));
			}
			const logsMatch = method === 'GET' && /^\/logs\/([^/]+)$/.exec(path);
			if (logsMatch) {
				const text = await reviews.logs(decodeURIComponent(logsMatch[1]), {
					tail: parseTail(url.searchParams.get('tail'))
				});
				res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
				return res.end(text);
			}

			return sendJson(res, 404, { error: 'not found' });
		} catch (e) {
			const status = Number.isInteger(e?.status) ? e.status : 500;
			if (status >= 500) log(`error on ${req.method} ${req.url}: ${e.stack || e.message}`);
			if (!res.headersSent) return sendJson(res, status, { error: e.message || 'internal error' });
		}
	};
}
