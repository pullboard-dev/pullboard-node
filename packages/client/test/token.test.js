import test from "node:test";
import assert from "node:assert/strict";
import { resolveToken } from "../src/token.js";

// Capture a thrown error (assert.throws does not return it).
function caught(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail("expected the call to throw");
}

// A fake filesystem: `files` maps absolute paths to contents; missing = absent.
function fakeFs(files) {
  return {
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => files[path],
  };
}

const ROOT = "/repo";
const PROJECT = { [`${ROOT}/.pullboard/project.json`]: JSON.stringify({ workspace: "ws-123" }) };

test("explicit PULLBOARD_TOKEN wins over every other source", () => {
  const r = resolveToken({ env: { PULLBOARD_TOKEN: "  env-tok  " }, cwd: `${ROOT}/apps/api`, ...fakeFs({ ...PROJECT, [`${ROOT}/runtime-keys/pullboard-prod.token`]: "file-tok" }) });
  assert.deepEqual(r, { token: "env-tok", source: "env:PULLBOARD_TOKEN", workspace: "ws-123" });
});

test("PULLBOARD_TOKEN_FILE is read when the env token is absent", () => {
  const r = resolveToken({ env: { PULLBOARD_TOKEN_FILE: "/secrets/t" }, cwd: ROOT, ...fakeFs({ ...PROJECT, "/secrets/t": "from-file\n" }) });
  assert.equal(r.token, "from-file");
  assert.equal(r.source, "env:PULLBOARD_TOKEN_FILE");
});

test("configToken (~/.pullboard/config.json from `pullboard init`) slots after env, before runtime-keys", () => {
  const files = fakeFs({ ...PROJECT, [`${ROOT}/runtime-keys/pullboard-prod.token`]: "runtime-tok" });
  // With no env token, an injected config token wins over the runtime-keys fallback.
  const r = resolveToken({ env: {}, cwd: ROOT, configToken: "  cfg-tok  ", ...files });
  assert.equal(r.token, "cfg-tok");
  assert.equal(r.source, "config:~/.pullboard/config.json");
  // An env token still outranks the config token.
  const env = resolveToken({ env: { PULLBOARD_TOKEN: "env-tok" }, cwd: ROOT, configToken: "cfg-tok", ...files });
  assert.equal(env.source, "env:PULLBOARD_TOKEN");
  // A blank config token is ignored, falling through to runtime-keys.
  const blank = resolveToken({ env: {}, cwd: ROOT, configToken: "   ", ...files });
  assert.equal(blank.token, "runtime-tok");
});

test("falls back to runtime-keys, resolved by walking up to the project root, per role", () => {
  const files = fakeFs({ ...PROJECT, [`${ROOT}/runtime-keys/pullboard-prod.token`]: "builder-tok\n", [`${ROOT}/runtime-keys/pullboard-verifier.token`]: "verifier-tok" });
  const builder = resolveToken({ env: {}, cwd: `${ROOT}/apps/api/src`, ...files });
  assert.equal(builder.token, "builder-tok");
  assert.equal(builder.source, `file:${ROOT}/runtime-keys/pullboard-prod.token`);
  assert.equal(builder.workspace, "ws-123");
  const verifier = resolveToken({ role: "verifier", env: {}, cwd: ROOT, ...files });
  assert.equal(verifier.token, "verifier-tok");
});

test("a newer builder filename takes precedence over the legacy prod name", () => {
  const r = resolveToken({ env: {}, cwd: ROOT, ...fakeFs({ ...PROJECT, [`${ROOT}/runtime-keys/pullboard-builder.token`]: "new", [`${ROOT}/runtime-keys/pullboard-prod.token`]: "legacy" }) });
  assert.equal(r.token, "new");
});

test("no token anywhere fails LOUD, naming the board and every source checked", () => {
  const error = caught(() => resolveToken({ env: {}, cwd: `${ROOT}/apps`, ...fakeFs(PROJECT) }));
  assert.equal(error.code, "PULLBOARD_NO_TOKEN");
  assert.match(error.message, /NOT connected to board ws-123/);
  assert.match(error.message, /runtime-keys\/pullboard-prod\.token/);
  assert.match(error.message, /Checked: env PULLBOARD_TOKEN;/);
  // Outside any project (no .pullboard/project.json) it still fails loud, generically.
  const orphan = caught(() => resolveToken({ env: {}, cwd: "/tmp/nowhere", exists: () => false, read: () => "" }));
  assert.equal(orphan.code, "PULLBOARD_NO_TOKEN");
  assert.match(orphan.message, /any Pullboard board/);
});

test("an empty or whitespace token file is treated as absent (never a blank bearer)", () => {
  const error = caught(() => resolveToken({ env: { PULLBOARD_TOKEN: "   " }, cwd: ROOT, ...fakeFs({ ...PROJECT, [`${ROOT}/runtime-keys/pullboard-prod.token`]: "  \n" }) }));
  assert.equal(error.code, "PULLBOARD_NO_TOKEN");
  // A malformed project.json degrades to a null workspace, not a crash.
  const r = resolveToken({ env: { PULLBOARD_TOKEN: "t" }, cwd: ROOT, ...fakeFs({ [`${ROOT}/.pullboard/project.json`]: "{not json" }) });
  assert.equal(r.workspace, null);
});
