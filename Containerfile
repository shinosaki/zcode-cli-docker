# syntax=docker/dockerfile:1.7
# =============================================================================
# zcode CLI container — supply-chain hardened build
#
# Stage 1 (builder): clone upstream ZCode at a tag whose commit SHA is pinned,
#   install exactly the upstream pnpm-lock.yaml (frozen) through a filtering
#   registry, run upstream's own distribution build, verify the tarball digest
#   upstream just produced, and stage /out/zcode.
# Stage 2 (runtime): the same digest-pinned Node/Debian base image, plus a
#   minimal toolset for an interactive coding agent (git, ssh, curl, tini),
#   running as an unprivileged user against an immutable /opt/zcode.
#
# Every ARG below is REQUIRED and passed from zcode-version.env by CI. The
# build fails fast if any pin is missing (no silent defaults for security
# inputs).
# =============================================================================

ARG NODE_IMAGE=docker.io/library/node
# NOTE: the defaults below are illustrative; CI always passes the values
# from zcode-version.env as build-args, so this default going stale after a
# node-bump PR is harmless.
ARG NODE_IMAGE_TAG=24.14.1-bookworm-slim
ARG NODE_IMAGE_DIGEST

# -----------------------------------------------------------------------------
# Stage 1: builder (not shipped)
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE}:${NODE_IMAGE_TAG}@${NODE_IMAGE_DIGEST} AS builder

# -- pins (required) -----------------------------------------------------------
ARG ZCODE_TAG
ARG ZCODE_VERSION
ARG ZCODE_COMMIT
ARG ZCODE_UPSTREAM_URL
ARG PNPM_VERSION
ARG PNPM_INTEGRITY
ARG NPM_REGISTRY
ARG MINIMUM_RELEASE_AGE_MINUTES

# Fail fast if CI forgot to pass a pin.
RUN test -n "${ZCODE_TAG}" -a -n "${ZCODE_VERSION}" -a -n "${ZCODE_COMMIT}" \
      -a -n "${ZCODE_UPSTREAM_URL}" -a -n "${PNPM_VERSION}" -a -n "${PNPM_INTEGRITY}" \
      -a -n "${NPM_REGISTRY}" -a -n "${MINIMUM_RELEASE_AGE_MINUTES}" \
  || { echo "FATAL: missing required build-arg (see Containerfile header)" >&2; exit 1; }

# Validate formats before doing anything else.
RUN echo "${ZCODE_TAG}"    | grep -Eqx '^v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$' \
  && echo "${ZCODE_VERSION}" | grep -Eqx '(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})' \
  && echo "${ZCODE_COMMIT}"  | grep -Eqx '[0-9a-f]{40}' \
  && echo "${NPM_REGISTRY}"  | grep -Eqx '^https://.+' \
  && echo "${MINIMUM_RELEASE_AGE_MINUTES}" | grep -Eqx '^[0-9]+$'

ENV DEBIAN_FRONTEND=noninteractive
# Builder needs git plus the native toolchain used by node-gyp fallbacks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ca-certificates python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# -- pnpm: exact version, official registry, pinned integrity (canary) ---------
# The toolchain itself comes from registry.npmjs.org (not NPM_REGISTRY) and is
# verified against the integrity recorded in zcode-version.env. If npmjs ever
# serves different bytes for this immutable version, the build fails here.
RUN echo "verifying pnpm ${PNPM_VERSION} integrity" \
  && ACTUAL="$(npm view "pnpm@${PNPM_VERSION}" dist.integrity --registry=https://registry.npmjs.org/)" \
  && [ "${ACTUAL}" = "${PNPM_INTEGRITY}" ] \
  || { echo "FATAL: pnpm integrity drift: ${ACTUAL} != ${PNPM_INTEGRITY}" >&2; exit 1; } \
  && npm install --global "pnpm@${PNPM_VERSION}" --registry=https://registry.npmjs.org/ \
  && [ "$(pnpm --version)" = "${PNPM_VERSION}" ]

# -- fetch upstream at the pinned tag and assert the pinned commit -------------
# Tags are mutable; the commit SHA is the real pin. A tag that moved (or a
# retargeted tag) fails this check instead of silently shipping different code.
WORKDIR /src
RUN git init -q /src \
  && git -C /src remote add origin "${ZCODE_UPSTREAM_URL}" \
  && git -C /src fetch --depth 1 --quiet origin "refs/tags/${ZCODE_TAG}" \
  && git -C /src checkout --quiet --detach FETCH_HEAD \
  && ACTUAL="$(git -C /src rev-parse HEAD)" \
  && [ "${ACTUAL}" = "${ZCODE_COMMIT}" ] \
  || { echo "FATAL: tag ${ZCODE_TAG} does not point at pinned commit" \
            "(${ACTUAL} != ${ZCODE_COMMIT}) — refusing to build" >&2; exit 1; }

# -- install exactly the upstream lockfile (no resolution) ----------------------
# Filtered to the workspaces the distribution build needs (@zcode/cli, server,
# web and their workspace dependencies). pnpm 10 only runs lifecycle scripts of
# packages allow-listed in upstream pnpm-workspace.yaml (allowBuilds).
#
# Registry: the npm_config_registry env var overrides any registry config
# inherited from the upstream tree, so NPM_REGISTRY is always what is actually
# used. minimumReleaseAge (pnpm unit: minutes) is passed explicitly as
# defense-in-depth for any future re-resolution; a frozen lockfile normally
# performs none.
ENV npm_config_registry=${NPM_REGISTRY}
RUN pnpm install --frozen-lockfile \
      --config.minimum-release-age="${MINIMUM_RELEASE_AGE_MINUTES}" \
  --child-concurrency=1 \
  --network-concurrency=8 \
      --filter "@zcode/cli..." --filter "@zcode/server..." --filter "@zcode/web..."

# @zcode/shared is a source-only package that upstream's SEA/TUI asset staging
# requires as dist files; its own tsconfig compiles it (used by upstream dev
# flows via project references).
RUN pnpm exec tsc -p packages/shared/tsconfig.json

# -- build the distribution with upstream's own script --------------------------
# Produces dist/zcode/releases/<v>/zcode-<v>.tar.gz + sha256.txt + latest.json.
RUN node scripts/build-zcode.mjs \
      --base-url "https://zcode.container.invalid/" \
      --version "${ZCODE_VERSION}"

# -- extract and self-test -------------------------------------------------------
# The sha256 comparison is a CORRUPTION/canary check (truncated or mutated
# tarball, and the digest lands in the build provenance). It is NOT an
# upstream-compromise control: the checksum file is produced by the same build
# as the tarball. The real controls are the pinned commit + frozen lockfile +
# the human-reviewed update PR.
RUN cd dist/zcode/releases/"${ZCODE_VERSION}" \
  && sha256sum --strict --check sha256.txt \
  && mkdir -p /out \
  && tar -xzf "zcode-${ZCODE_VERSION}.tar.gz" -C /out \
  && test -x /out/zcode/bin/zcode.mjs \
  && ZCODE_DATA_BASE_DIR=/tmp/zdata node /out/zcode/bin/zcode.mjs --version \
      | grep -Fx "${ZCODE_VERSION}"

# -----------------------------------------------------------------------------
# Stage 2: runtime (shipped)
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE}:${NODE_IMAGE_TAG}@${NODE_IMAGE_DIGEST}

ARG ZCODE_TAG
ARG ZCODE_VERSION
ARG ZCODE_COMMIT

LABEL org.opencontainers.image.title="zcode-cli" \
      org.opencontainers.image.description="zcode CLI (Z.ai coding agent) built from a pinned upstream tag" \
      org.opencontainers.image.version="${ZCODE_VERSION}" \
      org.opencontainers.image.revision="${ZCODE_COMMIT}" \
      org.opencontainers.image.source="https://github.com/zai-org/ZCode" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive
# Minimal interactive coding-agent toolset:
#   git/openssh-client — the agent works on repositories
#   ca-certificates    — TLS to model APIs
#   curl               — diagnostics / health probing by the operator
#   tini               — PID 1 signal reaping for interactive TUI use
#   procps, tzdata     — ps/kill and correct timestamps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git openssh-client tini procps tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --user-group --create-home --home-dir /home/zcode \
       --shell /bin/bash zcode \
  && mkdir -p /workspace \
  && chown zcode:zcode /workspace

# Runtime payload: root-owned and write-protected. The CLI can never modify its
# own runtime; upgrades happen by publishing a new image, not in place.
COPY --from=builder /out/zcode /opt/zcode
RUN chmod -R a-w /opt/zcode

# Launcher mirrors upstream's install.sh semantics: exec node on the runner.
COPY <<'EOF' /usr/local/bin/zcode
#!/bin/sh
set -eu
exec node /opt/zcode/bin/zcode.mjs "$@"
EOF
RUN chmod 0755 /usr/local/bin/zcode

USER zcode
WORKDIR /workspace

# No args -> TUI (upstream default). Mount your project: -v "$PWD":/workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zcode"]
