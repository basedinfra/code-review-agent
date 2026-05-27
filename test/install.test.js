// Phase 2 installer tests. The real install path (Tailscale join → compose up →
// register → service) is exercised by the Phase 4 CI Mac-runner e2e; here we
// pin the two things that are unit-testable off-host:
//
//   1. `--dry-run` walks the WHOLE pipeline, redacts secrets, and touches NOTHING
//      on disk (so an operator — or this test — can preview an install safely).
//   2. the input contract: required-env / unknown-arg / --help / --no-service.
//
// shellcheck (CI) covers the scripts' syntax; this covers their behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install/agent', import.meta.url));
const bootScript = fileURLToPath(new URL('../install/agent-boot.sh', import.meta.url));

// Run a script under bash, returning { status, stdout, stderr }. Never throws on
// a non-zero exit (we assert on the code), so both success and failure paths read
// the same way.
function runScript(script, args, env = {}) {
	try {
		const stdout = execFileSync('bash', [script, ...args], {
			env: { ...process.env, ...env },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
		return { status: 0, stdout, stderr: '' };
	} catch (e) {
		return {
			status: e.status ?? 1,
			stdout: String(e.stdout ?? ''),
			stderr: String(e.stderr ?? '')
		};
	}
}

const REQUIRED_ENV = {
	BACKEND_ID: '42',
	LOGIN_SERVER: 'https://headscale.example.com:8443',
	DASHBOARD_URL: 'https://dashboard.example.com'
};

test('--dry-run walks the full pipeline and touches nothing on disk', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'cr-agent-'));
	const installDir = join(tmp, 'agent');
	try {
		const { status, stdout } = runScript(installer, ['--dry-run'], {
			...REQUIRED_ENV,
			INSTALL_DIR: installDir,
			// Secrets intentionally absent — a dry run must not require or prompt them.
			TS_AUTHKEY: '',
			BISESS_TOKEN: '',
			BACKEND_BOOTSTRAP_TOKEN: ''
		});

		assert.equal(status, 0);
		// Every pipeline stage is previewed.
		assert.match(stdout, /DRY RUN/);
		assert.match(stdout, /tailscale up/);
		assert.match(stdout, /docker compose up -d/);
		assert.match(stdout, /register\.js/);
		assert.match(stdout, /agent-boot\.sh/); // the reboot-survival service
		// The pre-auth key is shown as a shape, never as a value.
		assert.match(stdout, /--authkey=<redacted>/);
		// And nothing was written: the install dir must not exist after a dry run.
		assert.equal(existsSync(installDir), false, 'dry run must not create the install dir');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('--no-service skips the reboot-survival service', () => {
	const { status, stdout } = runScript(installer, ['--dry-run', '--no-service'], REQUIRED_ENV);
	assert.equal(status, 0);
	assert.match(stdout, /skipping reboot-survival service/);
	assert.doesNotMatch(stdout, /agent-boot\.sh/);
});

test('missing required env fails fast with a clear message', () => {
	const { status, stderr } = runScript(installer, ['--dry-run'], {
		BACKEND_ID: '',
		LOGIN_SERVER: '',
		DASHBOARD_URL: ''
	});
	assert.equal(status, 1);
	assert.match(stderr, /missing required env/);
});

test('an unknown argument is rejected', () => {
	const { status, stderr } = runScript(installer, ['--bogus'], REQUIRED_ENV);
	assert.equal(status, 1);
	assert.match(stderr, /unknown argument/);
});

test('--help documents the flags and exits 0', () => {
	const { status, stdout } = runScript(installer, ['--help']);
	assert.equal(status, 0);
	assert.match(stdout, /--dry-run/);
	assert.match(stdout, /--no-service/);
	assert.match(stdout, /BACKEND_ID/);
});

test('agent-boot.sh refuses a dir with no docker-compose.yml (before any docker call)', () => {
	// The compose-file guard is the first line of the wrapper's main(), ahead of
	// the docker/tailscale waits — so this never shells out to a real engine.
	const { status, stderr } = runScript(bootScript, [join(tmpdir(), 'cr-agent-nonexistent-dir')]);
	assert.notEqual(status, 0);
	assert.match(stderr, /no docker-compose\.yml/);
});
