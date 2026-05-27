// PR-Agent container shaping: how a `/review` RPC becomes a Docker create config.
//
// Decision (Sprint 4): NO LiteLLM proxy. Provider API keys arrive in the
// `/review` body and are passed straight to the ephemeral PR-Agent container as
// env — never written to the BYO machine's disk (the legacy `pragent/deployer.js`
// wrote an --env-file; this reverses that). PR-Agent reads dot-style config keys
// (`OPENAI.KEY`, `GITHUB.USER_TOKEN`, …) via dynaconf, matching the dashboard's
// existing convention.

// Map the RPC body's provider-key slots → PR-Agent env var names (dynaconf
// dot-style). This table is the single place to adjust if PR-Agent's expected
// names change. Gemini uses PR-Agent's Google-AI-Studio section
// (GOOGLE_AI_STUDIO.GEMINI_API_KEY), not a bare GEMINI.KEY.
export const PROVIDER_ENV = {
	openai: 'OPENAI.KEY',
	anthropic: 'ANTHROPIC.KEY',
	gemini: 'GOOGLE_AI_STUDIO.GEMINI_API_KEY',
	github: 'GITHUB.USER_TOKEN'
};

/**
 * Build the Docker `Env` array (KEY=VALUE strings) for a PR-Agent run. Only keys
 * actually supplied are emitted (no empty placeholders).
 *
 * @param {{
 *   providerKeys?: Record<string, string>,
 *   githubToken?: string,
 *   model?: string,
 *   reasoningEffort?: string
 * }} [opts]
 * @returns {string[]}
 */
export function buildPrAgentEnv({ providerKeys = {}, githubToken, model, reasoningEffort } = {}) {
	const env = ['CONFIG.GIT_PROVIDER=github', 'GITHUB.DEPLOYMENT_TYPE=user'];
	const push = (key, value) => {
		if (value != null && value !== '') env.push(`${key}=${value}`);
	};
	// Driven by PROVIDER_ENV so a new provider is a one-line table edit. GitHub
	// accepts a top-level githubToken in addition to providerKeys.github.
	for (const [slot, envKey] of Object.entries(PROVIDER_ENV)) {
		const value = slot === 'github' ? (githubToken ?? providerKeys.github) : providerKeys[slot];
		push(envKey, value);
	}
	if (model) {
		push('CONFIG.MODEL', model);
		push('CONFIG.MODEL_TURBO', model);
	}
	if (reasoningEffort && reasoningEffort !== 'none') {
		push('CONFIG.REASONING_EFFORT', reasoningEffort);
	}
	return env;
}

/**
 * Parse a Docker-style memory string (`2g`, `512m`, `1073741824`) to bytes.
 *
 * @param {string | number} spec
 * @returns {number} bytes (0 if unparseable → no limit)
 */
export function parseMemoryToBytes(spec) {
	if (typeof spec === 'number') return spec > 0 ? Math.round(spec) : 0;
	const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(String(spec).trim());
	if (!m) return 0;
	const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
	return Math.round(parseFloat(m[1]) * mult);
}

/**
 * Default PR-Agent CLI args for a review action. Exact flags are PR-Agent-version
 * specific and confirmed in Sprint 5 against the real image; Sprint 4 validates
 * the run plumbing against a mock, and the RPC body may override `cmd` directly.
 *
 * @param {string} command e.g. '/review', '/improve', '/describe'
 * @param {string} prUrl
 * @returns {string[]}
 */
export function defaultPrAgentCmd(command, prUrl) {
	const action =
		String(command || '/review')
			.replace(/^\//, '')
			.trim() || 'review';
	// Tokenize on whitespace so a multi-word command (e.g. "/ask some question")
	// becomes separate argv items rather than one. For commands with quoted args
	// or flags, the RPC should send an explicit `cmd` array instead.
	return ['--pr_url', prUrl, ...action.split(/\s+/)];
}

/**
 * Assemble the Engine API container-create config for one ephemeral review.
 *
 * @param {{
 *   image: string,
 *   env?: string[],
 *   cmd?: string[],
 *   memoryBytes?: number,
 *   networkMode?: string | null,
 *   labels?: Record<string, string>
 * }} opts
 * @returns {object}
 */
export function buildPrAgentCreateConfig({
	image,
	env = [],
	cmd,
	memoryBytes = 0,
	networkMode,
	labels = {}
} = {}) {
	const config = {
		Image: image,
		Env: env,
		Labels: labels,
		HostConfig: {
			// Keep the container after exit so /logs/:id can read results; the
			// dashboard (Sprint 5) or a reaper removes it after fetching.
			AutoRemove: false,
			RestartPolicy: { Name: 'no' }
		}
	};
	if (Array.isArray(cmd) && cmd.length) config.Cmd = cmd;
	if (memoryBytes > 0) config.HostConfig.Memory = memoryBytes;
	if (networkMode) config.HostConfig.NetworkMode = networkMode;
	return config;
}
