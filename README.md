# code-review-agent (BaseInfra)

The **BYO code-review agent runtime** — the thing an operator installs on a spare
machine (a Mac mini, a Linux box) to run [PR-Agent](https://github.com/Codium-ai/pr-agent)
code reviews on demand. It joins a [Headscale](https://headscale.net) tailnet,
registers itself with the BaseInfra dashboard, and stands ready as an
always-warm review worker.

```dockerfile
FROM ghcr.io/basedinfra/code-review-agent:v1
```

> **Status:** Sprint 4. The agent runtime + RPC surface are implemented and
> tested against a mock; the dashboard-side driver that actually *calls* `/review`
> (and the rotating long-lived RPC token) land in Sprint 5.

## How it works

```text
BYO machine (network_mode: host)
  tailscale ──── joins via --login-server=https://headscale.<domain>:8443
  ┌─────────────────────────────────────────────────────────────┐
  │ code-review-agent  ── HTTP on [tailnet-ip]:7777              │
  │      │  DOCKER_HOST=tcp://socket-proxy:2375                  │
  │      ▼                                                       │
  │ docker-socket-proxy  (CONTAINERS/IMAGES/POST/NETWORKS, EXEC=0)│
  │      │                                                       │
  │      ▼                                                       │
  │ pr-agent  (ephemeral, per-review; provider keys via env)     │
  └─────────────────────────────────────────────────────────────┘
        │ one-shot register (bisess_ bootstrap token)
        ▼
  BaseInfra dashboard  POST /api/agents/code-review/register
```

The agent never touches the raw Docker socket — it speaks the Docker Engine API
to a [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
with a tight allowlist. Provider API keys (`OPENAI.KEY`, `ANTHROPIC.KEY`,
`GEMINI.KEY`, `GITHUB.USER_TOKEN`) arrive **per-review in the RPC body** and are
passed to the ephemeral PR-Agent container as env — never persisted on the
BYO machine.

## HTTP RPC surface

Bound to the **tailnet IP only** (never `0.0.0.0`). Every endpoint except
`/health` requires a `Bearer` session token (`bisess_*`) from a tailnet source.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Self-check (Docker reachable, RAM/disk, runtime). Used by the installer + pairing-wizard probe. No auth. |
| `/pull-images` | POST | Pre-pull the PR-Agent image (warm the cache). |
| `/review` | POST | Start a review: run an ephemeral PR-Agent container with the provider keys from the body. Returns a review id. |
| `/review/cancel` | POST | Cancel an in-flight review (stop + remove its container). |
| `/logs/:id` | GET | Tail a review's PR-Agent container logs. |

## Image

- **Registry**: [`ghcr.io/basedinfra/code-review-agent`](https://github.com/basedinfra/code-review-agent/pkgs/container/code-review-agent)
- **Architectures**: `linux/amd64`, `linux/arm64`
- **Runtime deps**: none (Node standard library only)
- **License**: MIT (this repo); see `NOTICE.md` for bundled/orchestrated software
- **Attestations**: provenance + SBOM (on the GHCR package page)

## Install

```bash
# On the BYO machine. The bootstrap token + login server come from the
# dashboard's pairing wizard; the token is read from stdin (never argv).
curl -fsSL https://raw.githubusercontent.com/basedinfra/code-review-agent/main/install/agent | \
  BACKEND_ID=42 \
  LOGIN_SERVER=https://headscale.example.com:8443 \
  DASHBOARD_URL=https://dashboard.example.com \
  bash
```

> Fetches from the `main` git ref by default (the Docker `:v1` tag is published
> from a SemVer git tag and is not itself a git ref). Pin `REF=<release-tag>` for
> reproducibility. On Linux the installer uses `sudo` for `tailscale up`.

The installer detects OS/arch, installs Tailscale (idempotent), joins the
tailnet with `--advertise-tags=tag:backend-<id>,tag:baseinfra-agent`, pulls this
image, `docker compose up -d`s the agent + socket-proxy, waits for `/health`,
and runs the one-shot register (with `409`/`429` backoff while the node becomes
visible in Headscale).

## arm64 / Apple silicon

Upstream `codiumai/pr-agent` is **amd64-only**. On arm64 Mac minis the agent
runs it `--platform linux/amd64` under emulation (Rosetta on Docker
Desktop/OrbStack, qemu otherwise). Reviews work but run slower than native; this
is the v1 trade-off (an owned multi-arch PR-Agent image is a future option).

## Platform & networking (Phase 4)

The agent uses `network_mode: host` to bind the host's tailnet IP. This works on
**Linux** and **OrbStack**. Native **macOS Docker Desktop** mediates host
networking through its VM and cannot bind the host's `tailscale0` interface, so a
BYO Mac mini needs OrbStack (or a future tailscale-sidecar model). Relatedly, the
socket-proxy is reachable on host loopback under host networking, so any local
process on a multi-user box can reach the allowlisted Docker API — acceptable for
a single-operator box, but the production networking model (private bridge +
tailscale sidecar so the proxy is never host-reachable) is a **Sprint 4 Phase 4**
decision, validated against a real install. Tracked in the parent plan.

## Security model

- **Socket-proxy only.** The agent never mounts `/var/run/docker.sock`; only the
  proxy does, behind a `CONTAINERS/IMAGES/POST/NETWORKS` allowlist with `EXEC=0`.
- **Tailnet-bound RPC.** The HTTP server binds the `100.64.0.0/10` tailnet
  address; the dashboard reaches it over WireGuard. Requests from non-tailnet
  sources are rejected. **In Sprint 4 the tailnet is the security boundary** —
  the `Bearer bisess_*` check is structural (regex + CRC), not cryptographic
  proof the dashboard issued the token (any tailnet peer could mint a
  well-formed one). Verified, rotating `rpc`-token auth against the dashboard
  lands in Sprint 5.
- **Transient provider keys.** Keys arrive in the `/review` request and are
  passed to the ephemeral container's env — never written to the agent's disk.
  They do persist in that container's Docker config (readable via
  `docker inspect`) for its lifetime; capturing results and tearing the
  container down promptly is the dashboard's responsibility once it drives the
  review lifecycle (Sprint 5).
- **Secrets via stdin/env.** The bootstrap token and Tailscale pre-auth key are
  delivered to the installer via stdin/env (never the installer's own argv); any
  on-disk secret is mode `0600`. One unavoidable exception: `tailscale up` has no
  non-argv way to accept its key, so the key is briefly visible in that child
  process's argv — mitigated by single-use, ≤15-min pre-auth keys (already spent
  or expired if observed).

## Tag scheme

| Tag | Stability | Use when |
|-----|-----------|----------|
| `:v1` | Moving — refreshed weekly by the rebuild workflow | You want rolling security patches |
| `:v1.YYYYMMDD` | Immutable — date-stamped at publish time | You want a reproducible build pinned to a week |
| `:v1.0.0` (SemVer) | Immutable — matches the git tag | You want a reproducible build pinned to a release |
| `@sha256:…` | Immutable digest — strongest pin | Production (BaseInfra pins by digest) |

Find the current digest:

```bash
docker buildx imagetools inspect ghcr.io/basedinfra/code-review-agent:v1
```

## Versioning policy

- **Moving `:v1`** — rebuilt weekly (Mondays 08:00 UTC) to pull in upstream
  `node:24-alpine` refreshes and base-image security patches.
- **`:v1.YYYYMMDD`** — immutable, produced on every tag push and weekly rebuild.
- **`:v1.X.Y`** (git tag) — immutable, produced on tag push.
- **Major bump `:v2`** — only on a BC-breaking change. `:v1` stays alive ≥90
  days after `:v2` ships.

Publishing is gated on a tag push: `git tag v1.0.0 && git push --tags` runs
`publish.yml` (multi-arch build, smoke test, provenance + SBOM). PRs build amd64
and smoke-test only — they never push.

## Local validation

```bash
npm ci
npm run lint          # prettier --check + eslint
npm test              # node --test (unit)
docker buildx build --platform linux/amd64 --load -t code-review-agent:dev .
bash test/smoke.sh code-review-agent:dev
```

## Reporting issues

File issues at <https://github.com/basedinfra/code-review-agent/issues>.
