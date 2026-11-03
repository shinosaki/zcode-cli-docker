#!/usr/bin/env node
// ---------------------------------------------------------------------------
// verify-pin.mjs — CI-side verification of every pin in zcode-version.env
//
// This is the STRICT CANONICAL parser of zcode-version.env. It runs BEFORE any
// value from that file is loaded into the job environment, and it fails closed:
//
//   * duplicate keys are rejected (no first/last-wins parser differentials)
//   * unknown keys are rejected (typos and smuggled extras fail loudly)
//   * CR characters are rejected (CRLF edits cannot alter parsed values)
//   * the file must end with a newline (no silently-dropped last line)
//   * every value is format-checked
//
// Defense against:
//   * a retargeted/moved upstream tag (tag -> commit must match the pin)
//   * a bumped PR repointing the build at a different repository (the upstream
//     URL is hard-coded below and is NOT configurable through the pin file)
//   * leading-zero semver confusion (v3.15.01 vs v3.15.1)
//
// The builder inside the Containerfile re-verifies tag->commit independently,
// so skipping this script is not enough to build something else than pinned.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ENV_PATH = new URL("../zcode-version.env", import.meta.url);

// Code, not data: a version-bump PR must never be able to change where the
// source comes from. Keep this in sync with check-upstream-update.mjs and the
// build workflow (all three hard-code the same value).
export const UPSTREAM_URL = "https://github.com/zai-org/ZCode.git";

const SHA1_RE = /^[0-9a-f]{40}$/;
// No leading zeros: rejects v3.15.01 which git accepts but semver compares oddly.
const TAG_RE = /^v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
const SEMVER_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

const KNOWN_KEYS = [
  "ZCODE_TAG",
  "ZCODE_VERSION",
  "ZCODE_COMMIT",
  "NODE_IMAGE",
  "NODE_IMAGE_TAG",
  "NODE_IMAGE_DIGEST",
  "PNPM_VERSION",
  "PNPM_INTEGRITY",
  "NPM_REGISTRY",
  "MINIMUM_RELEASE_AGE_MINUTES",
  "MINIMUM_RELEASE_AGE_DAYS",
];

function fail(msg) {
  console.error(`[verify-pin] FATAL: ${msg}`);
  process.exit(1);
}

function parseEnvFileStrict(text) {
  const out = {};
  const lines = text.split("\n");
  if (!text.endsWith("\n")) fail("zcode-version.env must end with a newline");
  if (text.includes("\r")) fail("zcode-version.env must not contain CR characters (CRLF edits are not allowed)");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) fail(`malformed line: "${line}"`);
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Z0-9_]+$/.test(key)) fail(`invalid key name: ${key}`);
    if (key in out) fail(`duplicate key: ${key} (first wins is ambiguous; fix the file)`);
    if (!KNOWN_KEYS.includes(key)) fail(`unknown key: ${key}`);
    if (!value || /\s/.test(value)) fail(`key ${key} must have a non-empty value without whitespace`);
    if (/[<>"\\]/.test(value)) fail(`key ${key} value contains forbidden characters (< > " backslash)`);
    out[key] = value;
  }
  for (const key of KNOWN_KEYS) {
    if (!(key in out)) fail(`missing required key: ${key}`);
  }
  return out;
}

const env = parseEnvFileStrict(readFileSync(ENV_PATH, "utf8"));

// 1. Format checks -------------------------------------------------------------
if (!TAG_RE.test(env.ZCODE_TAG)) fail(`ZCODE_TAG not a stable semver tag: ${env.ZCODE_TAG}`);
if (!SEMVER_RE.test(env.ZCODE_VERSION)) fail(`ZCODE_VERSION not semver: ${env.ZCODE_VERSION}`);
if (env.ZCODE_VERSION !== env.ZCODE_TAG.slice(1)) {
  fail(`ZCODE_VERSION (${env.ZCODE_VERSION}) does not match ZCODE_TAG (${env.ZCODE_TAG})`);
}
if (!SHA1_RE.test(env.ZCODE_COMMIT)) fail(`ZCODE_COMMIT not a full 40-hex SHA-1: ${env.ZCODE_COMMIT}`);
if (!/^sha256:[0-9a-f]{64}$/.test(env.NODE_IMAGE_DIGEST)) fail("NODE_IMAGE_DIGEST must be sha256:<64 hex>");
if (!/^https:\/\//.test(env.NPM_REGISTRY)) fail("NPM_REGISTRY must be https");
if (!/^\d+$/.test(env.MINIMUM_RELEASE_AGE_MINUTES) || !/^\d+$/.test(env.MINIMUM_RELEASE_AGE_DAYS)) {
  fail("MINIMUM_RELEASE_AGE_* must be numeric");
}
// Cross-check the two representations of the cooling-off period.
if (Number(env.MINIMUM_RELEASE_AGE_MINUTES) !== Number(env.MINIMUM_RELEASE_AGE_DAYS) * 1440) {
  fail(
    `MINIMUM_RELEASE_AGE_MINUTES (${env.MINIMUM_RELEASE_AGE_MINUTES}) != ` +
      `MINIMUM_RELEASE_AGE_DAYS (${env.MINIMUM_RELEASE_AGE_DAYS}) * 1440`,
  );
}

// 2. Tag -> commit resolution against the live upstream repo ------------------
// Uses git ls-remote (no REST API, no rate limits, same code path the
// Containerfile uses to fetch). For annotated tags the peeled (^{}) entry is
// the commit; for lightweight tags the tag ref itself is the commit.
//
// NOTE: `git ls-remote <url> <exact-ref>` does NOT return the peeled (^{})
// line for annotated tags, but a trailing-`*` glob does. We glob and then
// filter to exact refs (a glob cannot be confused by v3.15.10 etc. because of
// the exact-match filter below; worst case is a false negative, never a
// false positive).
function lsRemote(pattern) {
  const out = execFileSync("git", ["ls-remote", UPSTREAM_URL, pattern], {
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\t/);
      return { sha, ref };
    })
    .filter(
      (r) =>
        r.ref === `refs/tags/${env.ZCODE_TAG}` || r.ref === `refs/tags/${env.ZCODE_TAG}^{}`,
    );
}

const refs = lsRemote(`refs/tags/${env.ZCODE_TAG}*`);
const peeled = refs.find((r) => r.ref === `refs/tags/${env.ZCODE_TAG}^{}`);
const direct = refs.find((r) => r.ref === `refs/tags/${env.ZCODE_TAG}`);
if (!direct) fail(`tag ${env.ZCODE_TAG} not found on ${UPSTREAM_URL}`);
const actualCommit = (peeled ?? direct).sha;
if (actualCommit !== env.ZCODE_COMMIT) {
  fail(
    `tag ${env.ZCODE_TAG} resolves to ${actualCommit}, pinned commit is ${env.ZCODE_COMMIT}. ` +
      "The tag moved (or the pin is wrong). Refusing to build.",
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      upstream: UPSTREAM_URL,
      zcode: { tag: env.ZCODE_TAG, version: env.ZCODE_VERSION, commit: env.ZCODE_COMMIT },
      baseImage: `${env.NODE_IMAGE}:${env.NODE_IMAGE_TAG}@${env.NODE_IMAGE_DIGEST}`,
      pnpm: env.PNPM_VERSION,
      npmRegistry: env.NPM_REGISTRY,
      minimumReleaseAge: { minutes: env.MINIMUM_RELEASE_AGE_MINUTES, days: env.MINIMUM_RELEASE_AGE_DAYS },
    },
    null,
    2,
  ),
);
