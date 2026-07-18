// Shared helpers for the Pullboard version-consistency checks. Kept dependency-free (Node stdlib
// only) so it can run inside `prepublishOnly` without a prior install step, and so a broken
// dependency graph can never mask a version-drift failure.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repoRoot>/scripts/version-lib.mjs, so the repo root is two levels up.
// Resolving from import.meta.url (not process.cwd()) means the checks give the same answer no
// matter which directory npm happens to invoke them from during a publish.
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadManifest(root = repoRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "VERSION_MANIFEST.json"), "utf8"));
  if (!manifest.canonicalVersion) {
    throw new Error("VERSION_MANIFEST.json is missing canonicalVersion");
  }
  return manifest;
}

// The one true internal-dependency range for a given shared version. The operator convention is a
// caret range on the exact shared version, so a divergent range is as much a drift as a divergent
// version.
export function expectedDepRange(version) {
  return `^${version}`;
}

export function readPackageJsonVersion(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8")).version;
}

export function readPackageJsonDep(absPath, depName) {
  const pkg = JSON.parse(readFileSync(absPath, "utf8"));
  return pkg.dependencies?.[depName];
}

// pyproject.toml — pull the `version = "x.y.z"` under [project]. A hand-rolled parse (rather than a
// TOML dependency) keeps this check installable-free and good enough for the single well-known key.
export function readPyprojectVersion(absPath) {
  const text = readFileSync(absPath, "utf8");
  const match = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  if (!match) throw new Error(`no version key found in ${absPath}`);
  return match[1];
}

// A Python `__version__ = "x.y.z"` dunder in a module source file.
export function readPythonDunderVersion(absPath) {
  const text = readFileSync(absPath, "utf8");
  const match = text.match(/^\s*__version__\s*=\s*["']([^"']+)["']/m);
  if (!match) throw new Error(`no __version__ found in ${absPath}`);
  return match[1];
}

export function readVersionByType(absPath, type) {
  switch (type) {
    case "package.json":
      return readPackageJsonVersion(absPath);
    case "pyproject.toml":
      return readPyprojectVersion(absPath);
    case "python-dunder":
      return readPythonDunderVersion(absPath);
    default:
      throw new Error(`unknown version-file type: ${type}`);
  }
}
