// Docker HEALTHCHECK probe: GET /health on the resolved bind address. Exit 0 on
// a 200, else 1. Dependency-free and fast.

import http from 'node:http';
import { loadConfig } from './config.js';

const config = loadConfig();
const req = http.request(
	{
		host: config.bindIp || '127.0.0.1',
		port: config.port,
		path: '/health',
		method: 'GET',
		timeout: 4000
	},
	(res) => {
		res.resume();
		process.exit(res.statusCode === 200 ? 0 : 1);
	}
);
req.on('error', () => process.exit(1));
req.on('timeout', () => {
	req.destroy();
	process.exit(1);
});
req.end();
