// /health response assembly. Always HTTP 200 — the dashboard's liveness signal
// is Headscale's node.online, NOT this endpoint; /health exists for the
// installer's readiness wait and the pairing-wizard UI probe. `status` is `ok`
// or `degraded` (degraded if Docker is unreachable or any warning is present).

/**
 * @param {{ systemCheck: { checks: object, warnings: Array<object> }, config: object, startedAt: number }} deps
 * @returns {object}
 */
export function buildHealth({ systemCheck, config, startedAt }) {
	const degraded = !systemCheck.checks.docker_reachable || systemCheck.warnings.length > 0;
	return {
		status: degraded ? 'degraded' : 'ok',
		version: config.agentVersion,
		uptime_s: Math.floor((Date.now() - startedAt) / 1000),
		bind: config.bindIp ? `${config.bindIp}:${config.port}` : null,
		checks: systemCheck.checks,
		warnings: systemCheck.warnings
	};
}
