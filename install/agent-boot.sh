#!/usr/bin/env bash
# Stage 2 of the BaseInfra code-review agent's reboot-survival service.
#
# Stage 1 is a launchd LaunchAgent (macOS) or a systemd unit (Linux) that runs
# this script at login/boot. This is the readiness gate, and it exists for two
# reasons launchd/systemd can't handle on their own:
#
#   1. `docker compose up -d` returns immediately — the containers run under the
#      Docker daemon, not under launchd/systemd — so the bring-up command can't
#      itself BE a long-running service unit. We do the bring-up and exit 0.
#   2. We may be started before the Docker engine and tailscale are ready (on
#      macOS the engine is the logged-in user's Docker Desktop/OrbStack, which
#      only starts at login). So we WAIT — bounded — for both, then bring the
#      stack up.
#
# Per-container liveness AFTER bring-up is Docker's job, not ours:
# docker-compose.yml sets `restart: unless-stopped`.
#
# Usage: agent-boot.sh [INSTALL_DIR]
#   INSTALL_DIR  dir holding docker-compose.yml + .env + agent.env
#                (default: this script's own directory)
set -euo pipefail

# launchd/systemd hand us a minimal PATH that omits where the docker + tailscale
# CLIs usually live (Homebrew, /usr/local). Prepend the usual locations so they
# resolve regardless of how the engine was installed.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

INSTALL_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# Bounded waits so a never-ready engine fails the unit instead of hanging forever.
DOCKER_WAIT_SECS="${DOCKER_WAIT_SECS:-180}"
TAILSCALE_WAIT_SECS="${TAILSCALE_WAIT_SECS:-120}"
# Guard against a non-numeric override — bare arithmetic on it under `set -e`
# would abort the wrapper. Fall back to the default unless it's all digits.
[[ "$DOCKER_WAIT_SECS" =~ ^[0-9]+$ ]] || DOCKER_WAIT_SECS=180
[[ "$TAILSCALE_WAIT_SECS" =~ ^[0-9]+$ ]] || TAILSCALE_WAIT_SECS=120

log() { printf '%s agent-boot: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }
die() { printf '%s agent-boot ERROR: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2; exit 1; }

# Wait for the Docker engine to answer. On macOS, Docker Desktop/OrbStack start
# at user login; on Linux, docker.service starts in parallel with us.
wait_for_docker() {
	command -v docker >/dev/null 2>&1 || die "docker not on PATH ($PATH)"
	local waited=0
	while ! docker info >/dev/null 2>&1; do
		if [ "$waited" -ge "$DOCKER_WAIT_SECS" ]; then
			die "Docker engine not ready after ${DOCKER_WAIT_SECS}s"
		fi
		sleep 3
		waited=$((waited + 3))
	done
	log "Docker engine ready"
}

# Wait for tailscale to assign an IPv4 — the agent binds the tailnet interface
# and crash-loops until it exists. Not fatal if the tailscale CLI isn't here (a
# sidecar model may own the tailnet); we just don't block on it.
wait_for_tailscale() {
	if ! command -v tailscale >/dev/null 2>&1; then
		log "tailscale CLI not on PATH; skipping tailnet wait"
		return
	fi
	local waited=0
	until [ -n "$(tailscale ip -4 2>/dev/null | head -n1)" ]; do
		if [ "$waited" -ge "$TAILSCALE_WAIT_SECS" ]; then
			# Soft failure — NOT fatal: bring the stack up anyway. A sidecar-tailscale
			# model may own the tailnet, and the agent retries the bind itself.
			log "WARNING: no tailnet IPv4 after ${TAILSCALE_WAIT_SECS}s; starting anyway (the agent will retry)"
			return
		fi
		sleep 3
		waited=$((waited + 3))
	done
	log "tailnet IPv4 assigned"
}

main() {
	# Fail fast (before any docker call) on a broken install dir. compose.yml is
	# checked first so the existing "missing compose file" test still trips here.
	[ -f "$INSTALL_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $INSTALL_DIR"
	[ -f "$INSTALL_DIR/agent.env" ] || die "no agent.env in $INSTALL_DIR (re-run the installer or restore it)"
	[ -f "$INSTALL_DIR/.env" ] || die "no .env in $INSTALL_DIR (re-run the installer or restore it)"
	log "bringing up the code-review agent from $INSTALL_DIR"
	wait_for_docker
	wait_for_tailscale
	cd "$INSTALL_DIR"
	docker compose up -d
	log "compose stack up"
}

main "$@"
