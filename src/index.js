// Agent entrypoint. Resolves config, REFUSES to start without a safe tailnet bind
// address (never 0.0.0.0), wires the Docker client + Reviews + HTTP server, and
// listens on the tailnet IP.

import http from 'node:http';
import { loadConfig } from './config.js';
import { DockerClient } from './docker-client.js';
import { Reviews } from './reviews.js';
import { createRequestListener } from './server.js';

function log(msg) {
	console.log(`[agent] ${new Date().toISOString()} ${msg}`);
}

function main() {
	const config = loadConfig();

	if (!config.bindIp) {
		console.error(
			'[agent] FATAL: no tailnet IP found to bind. Bring up Tailscale first, or set ' +
				'AGENT_BIND_IP explicitly (e.g. 127.0.0.1 for local testing). Refusing to bind 0.0.0.0.'
		);
		process.exit(1);
	}
	if (config.bindIp === '0.0.0.0' || config.bindIp === '::') {
		console.error('[agent] FATAL: refusing a wildcard bind; the RPC surface must be tailnet-only.');
		process.exit(1);
	}
	if (!config.bindIpExplicit) log(`auto-detected tailnet bind IP ${config.bindIp}`);

	const startedAt = Date.now();
	const docker = new DockerClient(config.dockerHost);
	const reviews = new Reviews({ docker, config, log });
	const handler = createRequestListener({ config, reviews, docker, startedAt, log });

	const server = http.createServer((req, res) => {
		Promise.resolve(handler(req, res)).catch((e) => {
			log(`unhandled: ${e.stack || e.message}`);
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'internal error' }));
			}
		});
	});

	server.listen(config.port, config.bindIp, () => {
		log(`code-review-agent v${config.agentVersion} listening on ${config.bindIp}:${config.port}`);
		log(
			`docker proxy ${config.dockerHost}; pr-agent ${config.prAgentImage} (${config.prAgentPlatform})`
		);
	});

	const shutdown = (sig) => {
		log(`${sig} received, shutting down`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
