// Intra-repo version guard for pullboard-node.
//
// Blocks a divergent publish AT THE SOURCE: every publishable workspace package must carry the
// single canonical version from VERSION_MANIFEST.json, and every internal @pullboard/* dependency
// range must be the caret form of that same version. Wired into `npm test` and each package's
// `prepublishOnly`, so `npm publish` physically cannot ship a mismatched set.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, loadManifest, expectedDepRange, readPackageJsonVersion, readPackageJsonDep } from "./version-lib.mjs";

export function checkWorkspaceVersions(root = repoRoot) {
  const manifest = loadManifest(root);
  const canonical = manifest.canonicalVersion;
  const errors = [];

  // Only the surfaces this repo actually owns (the three npm packages).
  const npmSurfaces = manifest.surfaces.filter((s) => s.repo === "pullboard-node");

  for (const surface of npmSurfaces) {
    const abs = join(root, surface.versionFile);
    const version = readPackageJsonVersion(abs);
    if (version !== canonical) {
      errors.push(`${surface.id}: version is ${version}, expected ${canonical} (${surface.versionFile})`);
    }
    for (const dep of surface.internalDeps ?? []) {
      const range = readPackageJsonDep(abs, dep);
      const want = expectedDepRange(canonical);
      if (range !== want) {
        errors.push(`${surface.id}: dependency "${dep}" is ${range ?? "MISSING"}, expected ${want} (${surface.versionFile})`);
      }
    }
  }

  return { ok: errors.length === 0, errors, canonicalVersion: canonical };
}

// Run directly (script / prepublishOnly / node --test all import the function; only a direct
// invocation should exit the process).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, errors, canonicalVersion } = checkWorkspaceVersions();
  if (ok) {
    console.log(`version check OK — all pullboard-node packages at ${canonicalVersion}`);
  } else {
    console.error(`version drift in pullboard-node (canonical ${canonicalVersion}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
