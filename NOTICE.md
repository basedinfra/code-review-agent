# Notices

This repository's code (the agent source, Dockerfile, workflows, installer) is
licensed under the MIT License. See `LICENSE`.

## Bundled in the published image

### Node.js

- Project: Node.js
- Upstream: https://github.com/nodejs/node
- Base image: `node:24-alpine` (pinned via `ARG NODE_VERSION` in the `Dockerfile`)
- License: MIT (Node.js core); the Alpine base bundles additional components
  under their own licenses (musl libc — MIT; BusyBox — GPL-2.0).

The agent itself has **zero production npm dependencies** — it runs on the Node
standard library only, so the image bundles no third-party JavaScript packages.

## Orchestrated at runtime (NOT bundled in this image)

These run as separate containers that the agent pulls/manages at runtime; they
are not part of this image and retain their own licenses:

- `tecnativa/docker-socket-proxy` — https://github.com/Tecnativa/docker-socket-proxy (Apache-2.0)
- `codiumai/pr-agent` — https://github.com/Codium-ai/pr-agent (Apache-2.0)
