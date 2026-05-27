# Changelog

All notable changes to the BaseInfra `code-review-agent` image are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for the major tag (`:v1`, `:v2`). Immutable date-stamped tags (`:v1.YYYYMMDD`)
are produced by the weekly rebuild.

## [1.0.0] — 2026-05-26

Initial release — Sprint 4 Phase 0 (the agent image repo).

### Added

- Node.js agent runtime (zero production npm dependencies; Node standard library
  only) exposing an HTTP RPC surface bound to the **tailnet IP only**:
  `GET /health`, `POST /pull-images`, `POST /review`, `POST /review/cancel`,
  `GET /logs/:id`.
- Docker Engine API client that talks exclusively to a **socket-proxy**
  (`tcp://socket-proxy:2375`) — never the raw `/var/run/docker.sock`.
- Per-review **ephemeral PR-Agent containers**: provider keys arrive in the
  `/review` RPC body and are passed as container env — never written to disk.
  PR-Agent runs `--platform linux/amd64` (Rosetta/qemu fallback on arm64 Macs).
- One-shot **register client** matching the dashboard's shipped contract
  (`Bearer bisess_*`, bounded exponential backoff on `409`/`429`, fatal on `401`).
- **First-run system check** (Docker reachability, RAM/disk thresholds, Tailscale
  status, container runtime kind) → `warnings: [{ kind: 'low_resources', … }]`
  surfaced in the register body without refusing to start.
- `docker-compose.yml` (agent + `tecnativa/docker-socket-proxy` with a tight
  `CONTAINERS/IMAGES/POST/NETWORKS` allowlist, `EXEC=0`).
- `install/agent` installer baseline (OS/arch detection, idempotent Tailscale
  install + join, image pull, compose up, register).
- Multi-arch builds (`linux/amd64`, `linux/arm64`) with provenance + SBOM; a
  weekly rebuild refreshing the `:v1` tag; a smoke test asserting `/health` boots.

### Deferred (later Sprint 4 phases)

- launchd/systemd service templates + installer `--dry-run` (Phase 2).
- Daily log-prune task (7 d / 100 MB) (Phase 3).
- CI Mac-runner end-to-end pairing test + the `/review` driver (Phase 4 / Sprint 5).
- **Verified RPC-token auth** — rotating `rpc` token validated against the
  dashboard (Sprint 5). Until then the tailnet-membership gate is the security
  boundary and the `Bearer` check is structural only.
- **Prompt review-container teardown** — capture results then remove the
  container so provider keys don't linger in Docker config (Sprint 5, when the
  dashboard drives the `/review` lifecycle).
- **Production networking model** (Sprint 4 Phase 4): `network_mode: host` binds
  the tailnet IP on Linux/OrbStack but not native macOS Docker Desktop, and it
  leaves the socket-proxy reachable on host loopback. A private-bridge +
  tailscale-sidecar model (proxy never host-reachable; macOS-native) is decided
  during real-install validation.
