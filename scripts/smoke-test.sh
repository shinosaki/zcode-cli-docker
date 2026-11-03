#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# smoke-test.sh — functional gate against the built image, BEFORE it is tagged
# as a release.
#
# Usage: bash scripts/smoke-test.sh <image-ref> <expected-zcode-version>
#        <image-ref> may be a tag (name:tag) or a digest (name@sha256:...)
#        — the workflow always passes a digest so the bytes under test are
#        exactly the bytes that get signed.
#
# Checks:
#   1. `zcode --version` reports exactly the pinned version
#   2. `zcode --help` renders
#   3. container runs as non-root (uid 10001)
#   4. /opt/zcode is read-only for the runtime user (immutable runtime)
#   5. `zcode --web` boots and answers /api/server-info (real server entry)
#      and stdout contains no module-resolution errors
#
# Implementation notes:
#   * HTTP bodies are captured to files before grepping — `grep -q` and
#     `head -c` on a pipe cause SIGPIPE (exit 141) false failures under
#     `set -o pipefail`.
#   * The web boot uses --network host because the server binds 127.0.0.1 by
#     default and we deliberately test the default (token-less) local posture.
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image-ref> <expected-version>}"
EXPECTED_VERSION="${2:?usage: smoke-test.sh <image-ref> <expected-version>}"
WEB_PORT="${WEB_PORT:-39303}"
TMP="$(mktemp -d)"
CID=""
# Single EXIT trap: removes the temp dir and, if the web-boot container was
# started, stops it.
cleanup() {
  if [ -n "${CID}" ]; then
    docker rm -f "${CID}" > /dev/null 2>&1 || true
  fi
  rm -rf "${TMP}"
}
trap cleanup EXIT

step() { printf '\n=== smoke: %s ===\n' "$1"; }

step "zcode --version"
GOT="$(docker run --rm --entrypoint /usr/local/bin/zcode "${IMAGE}" --version)"
echo "version: ${GOT}"
[ "${GOT}" = "${EXPECTED_VERSION}" ] || {
  echo "FATAL: version mismatch: got '${GOT}', want '${EXPECTED_VERSION}'" >&2
  exit 1
}

step "zcode --help"
docker run --rm --entrypoint /usr/local/bin/zcode "${IMAGE}" --help > "${TMP}/help.txt"
head -n 3 "${TMP}/help.txt"
grep -m1 "zcode" "${TMP}/help.txt" > /dev/null || {
  echo "FATAL: --help output does not mention zcode" >&2
  exit 1
}

step "non-root user check"
UID_IN_CONTAINER="$(docker run --rm --entrypoint /bin/sh "${IMAGE}" -c 'id -u')"
[ "${UID_IN_CONTAINER}" = "10001" ] || {
  echo "FATAL: expected uid 10001, got ${UID_IN_CONTAINER}" >&2
  exit 1
}

step "runtime immutability check (/opt/zcode must not be writable)"
if docker run --rm --entrypoint /bin/sh "${IMAGE}" -c 'test -w /opt/zcode'; then
  echo "FATAL: /opt/zcode is writable by the runtime user" >&2
  exit 1
else
  echo "read-only OK"
fi

step "web boot check"
CID="$(docker run --rm --detach --network host --entrypoint /usr/local/bin/zcode \
  "${IMAGE}" --web --workspace /workspace --no-open --port "${WEB_PORT}")"

READY=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/server-info" -o "${TMP}/server-info.json" 2> /dev/null; then
    if grep -q '"workspaces"' "${TMP}/server-info.json"; then
      READY=1
      break
    fi
  fi
  sleep 1
done
[ -n "${READY}" ] || {
  echo "FATAL: web server did not become ready" >&2
  docker logs "${CID}" >&2 || true
  exit 1
}
echo "server-info OK"

docker logs "${CID}" > "${TMP}/web.log" 2>&1 || true
if grep -qE "Cannot find (module|package)|ERR_MODULE_NOT_FOUND" "${TMP}/web.log"; then
  echo "FATAL: module resolution errors in web server logs" >&2
  cat "${TMP}/web.log" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:${WEB_PORT}/" -o "${TMP}/index.html"
grep -qi "<html" "${TMP}/index.html" || {
  echo "FATAL: web UI did not serve HTML" >&2
  exit 1
}
echo "web UI OK"

printf '\n=== smoke: ALL CHECKS PASSED for %s ===\n' "${IMAGE}"
