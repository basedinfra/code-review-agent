#!/usr/bin/env bash
# Smoke-tests the agent image: the HTTP server boots and /health answers 200 with
# a well-formed JSON body. Wired into publish.yml + weekly-rebuild.yml before the
# multi-arch push.
#
# The agent binds 127.0.0.1 inside the container (it refuses 0.0.0.0), so we probe
# from inside via the image's own healthcheck + busybox wget. Docker is NOT
# reachable here (no socket-proxy), so /health reports docker_reachable:false and
# status:degraded — expected; we only assert the server boots and answers.
set -euo pipefail

IMAGE="${1:-code-review-agent:dev}"
NAME="cr-agent-smoke-$$"
PORT=7777

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> starting $IMAGE"
docker run -d --name "$NAME" \
	-e AGENT_BIND_IP=127.0.0.1 \
	-e AGENT_ALLOW_LOOPBACK=true \
	-e "PORT=${PORT}" \
	"$IMAGE" >/dev/null

echo "==> waiting for /health (via the image healthcheck)"
ok=''
attempt=0
while [ "$attempt" -lt 30 ]; do
	if docker exec "$NAME" node src/healthcheck.js >/dev/null 2>&1; then
		ok=1
		break
	fi
	sleep 1
	attempt=$((attempt + 1))
done

if [ -z "$ok" ]; then
	echo "FAIL: /health did not come up"
	docker logs "$NAME" || true
	exit 1
fi

echo "==> /health body"
body="$(docker exec "$NAME" wget -qO- "http://127.0.0.1:${PORT}/health")"
echo "$body"

echo "$body" | grep -q '"status"' || { echo "FAIL: no status field"; exit 1; }
echo "$body" | grep -q '"version"' || { echo "FAIL: no version field"; exit 1; }
echo "$body" | grep -q '"checks"' || { echo "FAIL: no checks field"; exit 1; }

echo
echo "all checks passed"
