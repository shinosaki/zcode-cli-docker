#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-upstream-update.mjs — update detection (runs weekly on CI, or locally)
//
// Threat model note: this script DETECTS and PREPARES updates; it never
// publishes anything. Its output becomes a pull request that a human must
// review and merge — only the merge triggers the build-and-publish workflow.
// Automatic shipping of newly-appearing upstream code would defeat the whole
// supply-chain model, so there is deliberately no auto-merge anywhere.
//
// Modes:
//   (default)            detect changes, print a JSON summary to stdout
//   --apply upstream     rewrite zcode-version.env with the detected zcode tag
//   --apply node         rewrite zcode-version.env with the newer node patch tag + digest
//   --apply digest       rewrite zcode-version.env with the drifted digest (same tag)
//
// Detection covers three independent inputs (registry checks are non-fatal:
// a Docker Hub hiccup must never block an upstream security bump):
//   1. upstream zcode git tags (>= MINIMUM_RELEASE_AGE_DAYS commit-age gate)
//   2. newer node:24.14.x-bookworm-slim patch tags (tag+digest bumped together)
//   3. digest drift of the currently pinned node tag
//
// Uses only node stdlib + git (no REST API => no rate limits, works in CI).
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_PATH = new URL("../zcode-version.env", import.meta.url);

// Code, not data — must match verify-pin.mjs and the build workflow.
const UPSTREAM_URL = "https://github.com/zai-org/ZCode.git";

// Node.js version line we track. New PATCH releases of the same minor are
// security fixes; the detector proposes tag+digest bumps for them. Bumping the
// major/minor line is a deliberate, manual decision — edit this + the pin file.
const NODE_TRACKING_PREFIX = "24.14.";
const NODE_VARIANT_SUFFIX = "-bookworm-slim";
// How many patch numbers above the current one to probe (bounded API usage).
const MAX_PATCH_PROBES = 40;

const SHA1_RE = /^[0-9a-f]{40}$/;
// No leading zeros: v3.15.01 would compare equal to v3.15.1 numerically.
const SEMVER_RE = /^v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

function fail(msg) {
  console.error(`[update-check] FATAL: ${msg}`);
  process.exit(1);
}

function parseEnvFileStrict(text) {
  // Keep this consistent with verify-pin.mjs (the canonical parser).
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
  const out = {};
  if (!text.endsWith("\n")) fail("zcode-version.env must end with a newline");
  if (text.includes("\r")) fail("zcode-version.env must not contain CR characters");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) fail(`malformed line: ${rawLine}`);
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Z0-9_]+$/.test(key)) fail(`invalid key name: ${key}`);
    if (key in out) fail(`duplicate key: ${key}`);
    if (!KNOWN_KEYS.includes(key)) fail(`unknown key: ${key}`);
    if (!value || /\s/.test(value)) fail(`key ${key} must have a non-empty value without whitespace`);
    out[key] = value;
  }
  return out;
}

const env = parseEnvFileStrict(readFileSync(ENV_PATH, "utf8"));
const minAgeDays = Number(env.MINIMUM_RELEASE_AGE_DAYS ?? 7);
if (!Number.isFinite(minAgeDays) || minAgeDays < 0) fail("MINIMUM_RELEASE_AGE_DAYS invalid");

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

function compareSemver(a, b) {
  const pa = a.match(SEMVER_RE).slice(1).map(Number);
  const pb = b.match(SEMVER_RE).slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// --- 1. upstream zcode tags ---------------------------------------------------
let upstream = null;
{
  const lines = git(["ls-remote", "--tags", UPSTREAM_URL])
    .split(/\r?\n/)
    .filter(Boolean);
  const tags = new Map(); // tag name -> commit (peeled commit for annotated tags)
  for (const line of lines) {
    const [sha, ref] = line.split(/\t/);
    if (!ref?.startsWith("refs/tags/")) continue;
    const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (ref.endsWith("^{}")) tags.set(name, sha); // peeled = real commit
    else if (!tags.has(name)) tags.set(name, sha); // lightweight candidate
  }
  const stableTags = [...tags.keys()].filter((t) => SEMVER_RE.test(t));
  if (stableTags.length === 0) fail("no stable semver tags found upstream");
  stableTags.sort(compareSemver);
  const latestTag = stableTags.at(-1);
  const pinnedTag = env.ZCODE_TAG;
  if (!SEMVER_RE.test(pinnedTag)) fail(`pinned tag ${pinnedTag} is not a stable semver tag`);

  if (compareSemver(latestTag, pinnedTag) <= 0) {
    console.error(`[update-check] upstream: ${latestTag} is not newer than pinned ${pinnedTag}`);
  } else {
    const commit = tags.get(latestTag);
    if (!SHA1_RE.test(commit)) fail(`could not resolve commit for ${latestTag}`);

    // Resolve the commit DATE (committer date) with a shallow fetch (age gate
    // input). Committer date reflects actual commit creation; author date
    // would survive rebases and can look artificially aged.
    const tmp = mkdtempSync(join(tmpdir(), "zcode-update-"));
    try {
      git(["init", "-q", tmp]);
      git(["-C", tmp, "remote", "add", "origin", UPSTREAM_URL]);
      git(["-C", tmp, "fetch", "--depth", "1", "--quiet", "origin", `refs/tags/${latestTag}`]);
      const resolvedCommit = git(["-C", tmp, "rev-parse", "FETCH_HEAD^{commit}"]);
      if (resolvedCommit !== commit) {
        fail(`fetch resolved ${latestTag} to ${resolvedCommit}, ls-remote said ${commit}`);
      }
      const commitDate = git(["-C", tmp, "log", "-1", "--format=%cI", resolvedCommit]);
      const ageDays = Math.floor((Date.now() - Date.parse(commitDate)) / 86_400_000);
      if (ageDays < minAgeDays) {
        console.error(
          `[update-check] upstream: ${latestTag} is only ${ageDays}d old (< ${minAgeDays}d cooling-off); skipping`,
        );
      } else {
        upstream = {
          fromTag: pinnedTag,
          toTag: latestTag,
          toCommit: commit,
          commitDate,
          ageDays,
          compareUrl: `${UPSTREAM_URL.replace(/\.git$/, "")}/compare/${pinnedTag}...${latestTag}`,
          releaseUrl: `${UPSTREAM_URL.replace(/\.git$/, "")}/releases/tag/${latestTag}`,
        };
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// --- 2/3. base image: newer node patch tag, else digest drift ------------------
// Docker Hub auth scope and manifest path use the bare repo path
// ("library/node"), not the fully qualified "docker.io/library/node".
function imageRepoPath(image) {
  const withoutHost = image.replace(/^(docker\.io|registry-1\.docker\.io|index\.docker\.io)\//, "");
  return withoutHost.includes("/") ? withoutHost : `library/${withoutHost}`;
}

async function fetchRegistryToken(repoPath) {
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repoPath}:pull`,
  );
  if (!tokenRes.ok) throw new Error(`docker auth failed: ${tokenRes.status}`);
  const { token } = await tokenRes.json();
  return token;
}

async function resolveManifestDigest(repoPath, ref, token) {
  const res = await fetch(`https://registry-1.docker.io/v2/${repoPath}/manifests/${ref}`, {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    },
  });
  if (res.status === 404) return null; // tag does not exist
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const digest = res.headers.get("docker-content-digest");
  if (!digest) throw new Error("no docker-content-digest header");
  return digest;
}

let nodeUpdate = null;
let digestDrift = null;
try {
  const repoPath = imageRepoPath(env.NODE_IMAGE);
  const currentTag = env.NODE_IMAGE_TAG;
  const currentPatch = Number(currentTag.replace(NODE_TRACKING_PREFIX, "").replace(NODE_VARIANT_SUFFIX, ""));
  if (!Number.isInteger(currentPatch)) fail(`cannot parse patch number from NODE_IMAGE_TAG=${currentTag}`);

  // One token for the whole probe; descend from the highest candidate so the
  // first hit is the newest patch (fewest requests on average).
  const token = await fetchRegistryToken(repoPath);
  let newestTag = null;
  let newestDigest = null;
  for (let p = currentPatch + MAX_PATCH_PROBES; p >= currentPatch + 1; p -= 1) {
    const candidate = `${NODE_TRACKING_PREFIX}${p}${NODE_VARIANT_SUFFIX}`;
    const digest = await resolveManifestDigest(repoPath, candidate, token);
    if (digest) {
      newestTag = candidate;
      newestDigest = digest;
      break;
    }
  }
  if (newestTag && newestDigest) {
    nodeUpdate = {
      fromTag: currentTag,
      toTag: newestTag,
      fromDigest: env.NODE_IMAGE_DIGEST,
      toDigest: newestDigest,
    };
    console.error(`[update-check] node: newer patch tag ${newestTag} exists`);
  } else {
    // 3. same tag, moved digest (upstream rebuilt the manifest list)
    const currentDigest = await resolveManifestDigest(repoPath, currentTag, token);
    if (currentDigest === null) {
      // Fail-open for detection (with a loud warning): the pinned tag was
      // retired upstream. Never propose a null digest bump.
      throw new Error(
        `pinned tag ${currentTag} no longer exists on Docker Hub; manual intervention required`,
      );
    }
    if (currentDigest !== env.NODE_IMAGE_DIGEST) {
      digestDrift = { from: env.NODE_IMAGE_DIGEST, to: currentDigest };
      console.error(`[update-check] node: digest drifted for ${currentTag}`);
    } else {
      console.error("[update-check] node: base image digest unchanged");
    }
  }
} catch (error) {
  // Non-fatal on purpose: a registry outage must not block upstream bumps.
  console.error(`[update-check] WARNING: node/digest check failed: ${error?.message ?? error}`);
}

// --- output / apply -------------------------------------------------------------
const result = { upstream, nodeUpdate, digestDrift };
console.log(JSON.stringify(result, null, 2));

if (process.argv.includes("--apply")) {
  const kind = process.argv[process.argv.indexOf("--apply") + 1];
  const updates = {};
  if (kind === "upstream" && upstream) {
    updates.ZCODE_TAG = upstream.toTag;
    updates.ZCODE_VERSION = upstream.toTag.slice(1);
    updates.ZCODE_COMMIT = upstream.toCommit;
  } else if (kind === "node" && nodeUpdate) {
    updates.NODE_IMAGE_TAG = nodeUpdate.toTag;
    updates.NODE_IMAGE_DIGEST = nodeUpdate.toDigest;
  } else if (kind === "digest" && digestDrift) {
    updates.NODE_IMAGE_DIGEST = digestDrift.to;
  } else {
    fail(`nothing to apply for kind=${kind}`);
  }
  const text = readFileSync(ENV_PATH, "utf8");
  const rewritten = text
    .split("\n")
    .map((line) => {
      const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
      return key && key in updates ? `${key}=${updates[key]}` : line;
    })
    .join("\n");
  writeFileSync(ENV_PATH, rewritten);
  console.error(`[update-check] applied ${kind}: ${Object.keys(updates).join(", ")}`);
}
