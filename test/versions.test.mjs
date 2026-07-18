// Enforcement: every publishable pullboard-node package shares the single canonical version, and
// every internal @pullboard/* dependency range points at that same version. This runs as part of
// `npm test`, so version drift turns the suite red before anything can be published.
import test from "node:test";
import assert from "node:assert/strict";
import { checkWorkspaceVersions } from "../scripts/check-versions.mjs";

test("all npm workspace packages share the canonical version with valid internal deps", () => {
  const { ok, errors, canonicalVersion } = checkWorkspaceVersions();
  assert.ok(canonicalVersion, "VERSION_MANIFEST.json must define a canonical version");
  assert.ok(ok, `version drift (canonical ${canonicalVersion}):\n  ${errors.join("\n  ")}`);
});
