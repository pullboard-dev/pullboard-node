// Cross-surface version guard — the pre-release gate.
//
// Reads VERSION_MANIFEST.json and confirms that EVERY externally-published Pullboard surface (the
// three npm packages here, the OpenClaw/ClawHub plugin, and the PyPI package) reports the one
// canonical version — plus that the npm internal dependency ranges match. The non-npm surfaces live
// in sibling repos (pullboard-openclaw, pullboard-python) checked out next to this one; the path is
// `siblingRepoRoot` in the manifest.
//
// Run from the pullboard-node repo root before every release:  node scripts/check-surface-versions.mjs
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  repoRoot,
  loadManifest,
  expectedDepRange,
  readVersionByType,
  readPackageJsonDep,
} from "./version-lib.mjs";

// Map a surface's `repo` name to an absolute filesystem root. This repo is itself; siblings resolve
// off `siblingRepoRoot` (default "..").
function repoRootFor(surface, manifest, root) {
  if (surface.repo === "pullboard-node") return root;
  const base = resolve(root, manifest.siblingRepoRoot ?? "..");
  return join(base, surface.repo);
}

export function checkSurfaceVersions(root = repoRoot) {
  const manifest = loadManifest(root);
  const canonical = manifest.canonicalVersion;
  const errors = [];
  const warnings = [];
  const checked = [];

  for (const surface of manifest.surfaces) {
    const surfaceRoot = repoRootFor(surface, manifest, root);
    if (!existsSync(surfaceRoot)) {
      warnings.push(`${surface.id}: repo not checked out at ${surfaceRoot} — skipped`);
      continue;
    }

    const primary = join(surfaceRoot, surface.versionFile);
    if (!existsSync(primary)) {
      errors.push(`${surface.id}: version file missing at ${primary}`);
      continue;
    }

    // Primary version file.
    const version = readVersionByType(primary, surface.type);
    if (version !== canonical) {
      errors.push(`${surface.id}: version is ${version}, expected ${canonical} (${surface.versionFile})`);
    } else {
      checked.push(`${surface.id} @ ${version}`);
    }

    // Any secondary files that must agree (e.g. a Python __version__ dunder).
    for (const extra of surface.extraVersionFiles ?? []) {
      const extraAbs = join(surfaceRoot, extra.path);
      if (!existsSync(extraAbs)) {
        errors.push(`${surface.id}: extra version file missing at ${extraAbs}`);
        continue;
      }
      const extraVersion = readVersionByType(extraAbs, extra.type);
      if (extraVersion !== canonical) {
        errors.push(`${surface.id}: ${extra.path} is ${extraVersion}, expected ${canonical}`);
      }
    }

    // Internal npm dependency ranges must be the caret form of the canonical version.
    if (surface.type === "package.json") {
      for (const dep of surface.internalDeps ?? []) {
        const range = readPackageJsonDep(primary, dep);
        const want = expectedDepRange(canonical);
        if (range !== want) {
          errors.push(`${surface.id}: dependency "${dep}" is ${range ?? "MISSING"}, expected ${want}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, checked, canonicalVersion: canonical };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, errors, warnings, checked, canonicalVersion } = checkSurfaceVersions();
  console.log(`Pullboard cross-surface version check — canonical ${canonicalVersion}`);
  for (const c of checked) console.log(`  ok  ${c}`);
  for (const w of warnings) console.warn(`  warn  ${w}`);
  if (!ok) {
    console.error("\nversion drift across surfaces:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("\nall published surfaces agree.");
}
