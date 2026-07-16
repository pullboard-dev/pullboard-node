import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseArgs, run, HELP } from "../src/cli.js";

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

// A fake SDK client that records calls and returns canned lifecycle payloads.
function stubClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    getItem: async (id) => { calls.push(["getItem", id]); return { workId: id, criterionDigest: "sha256:crit", baseSHA: null, ...overrides.item }; },
    claim: async (id, opts) => { calls.push(["claim", id, opts]); return { leaseId: "lease-1" }; },
    submit: async (input) => { calls.push(["submit", input]); return { state: "pending-verify", assurance: "DEMO_UNTRUSTED", ...overrides.submit }; },
    verify: async (input) => { calls.push(["verify", input]); return { state: "closed", assurance: "DEMO_UNTRUSTED" }; },
    release: async (id) => { calls.push(["release", id]); return { released: true }; },
  };
}

test("parseArgs splits positionals, flags, and a -- passthrough tail", () => {
  const parsed = parseArgs(["build", "item-1", "--tier", "self-reported", "--base", "abc", "--", "npm", "run", "build"]);
  assert.equal(parsed.command, "build");
  assert.deepEqual(parsed.positionals, ["item-1"]);
  assert.deepEqual(parsed.flags, { tier: "self-reported", base: "abc" });
  assert.deepEqual(parsed.passthrough, ["npm", "run", "build"]);
  // A trailing boolean flag (no value) is captured as true.
  assert.equal(parseArgs(["get", "x", "--help"]).flags.help, true);
});

test("build claims, runs the command, and submits REAL evidence — a digest of the actual diff", async () => {
  const client = stubClient();
  const execCalls = [];
  const DIFF = "diff --git a/x b/x\n+real work";
  const exec = (cmd) => {
    execCalls.push(cmd);
    if (cmd === "git rev-parse HEAD") return "f".repeat(40) + "\n";
    if (cmd.startsWith("git rev-parse HEAD~1")) return "e".repeat(40) + "\n";
    if (cmd.startsWith("git diff")) return DIFF;
    return "";
  };
  const out = [];
  const code = await run(["build", "item-9", "--", "npm", "test"], { client, exec, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });

  assert.equal(code, 0);
  // It ran the passthrough build command.
  assert.ok(execCalls.includes("npm test"), "the -- command is executed");
  // It computed the diff between the resolved base and head.
  assert.ok(execCalls.some((c) => c === `git diff ${"e".repeat(40)}..${"f".repeat(40)}`), "diffs base..head");
  const submit = client.calls.find(([name]) => name === "submit")[1];
  assert.equal(submit.leaseId, "lease-1");
  assert.equal(submit.headSHA, "f".repeat(40), "real head SHA from git");
  assert.equal(submit.baseSHA, "e".repeat(40));
  assert.equal(submit.evidenceDigest, sha256(DIFF), "evidence is a digest of the ACTUAL diff, not a placeholder");
  assert.equal(submit.criterionDigest, "sha256:crit");
  assert.equal(submit.completionTier, "independent", "defaults to independent so a verifier is required");
  assert.ok(out.some((m) => m.includes("DEMO_UNTRUSTED") && m.includes("attestation")), "surfaces the trust gap honestly");
});

test("build honors --base/--tier and falls back to the empty tree when there is no prior commit", async () => {
  const client = stubClient({ submit: { state: "closed", assurance: "DEMO_UNTRUSTED" } });
  const exec = (cmd) => {
    if (cmd === "git rev-parse HEAD") return "a".repeat(40);
    if (cmd.startsWith("git rev-parse HEAD~1")) throw new Error("no prior commit");
    if (cmd.startsWith("git diff")) return ""; // no diff -> evidence falls back to the command text
    return "";
  };
  const out = [];
  await run(["build", "item-1", "--tier", "self-reported", "--", "make"], { client, exec, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  const submit = client.calls.find(([name]) => name === "submit")[1];
  assert.equal(submit.completionTier, "self-reported");
  assert.equal(submit.baseSHA, "0".repeat(40), "empty-tree base when HEAD~1 is unavailable");
  assert.equal(submit.evidenceDigest, sha256("make"), "no diff -> evidence digests the build command");
});

test("auth and command guards fail closed", async () => {
  const errs = [];
  // loadConfig injected empty so the guard never reads a real ~/.pullboard/config.json.
  assert.equal(await run(["get", "x"], { env: {}, loadConfig: () => ({}), error: (m) => errs.push(m) }), 1);
  assert.ok(errs[0].includes("PULLBOARD_TOKEN"));
  // help and unknown-command paths.
  const out = [];
  assert.equal(await run([], { env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) }), 0);
  assert.equal(out[0], HELP);
  const errs2 = [];
  assert.equal(await run(["frobnicate"], { env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs2.push(m) }), 1);
  assert.ok(errs2[0].includes("unknown command"));
});

test("get unwraps the item, claim prints the lease, verify and release pass through", async () => {
  const client = stubClient();
  const out = [];
  await run(["get", "item-2"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.match(out[0], /"workId": "item-2"/);
  out.length = 0;
  await run(["claim", "item-2", "--role", "verifier", "--ttl", "60"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.equal(out[0], "lease-1");
  assert.deepEqual(client.calls.find(([n]) => n === "claim")[2], { role: "verifier", ttl: 60 });
  out.length = 0;
  await run(["verify", "item-2", "--lease", "L", "--submission", "S", "--decision", "ACCEPT", "--reason", "CRITERION_MET"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.match(out[0], /decision=ACCEPT/);
  out.length = 0;
  await run(["release", "lease-x"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.equal(out[0], "released");
  // A missing required argument fails closed.
  const errs = [];
  assert.equal(await run(["get"], { client, env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs.push(m) }), 1);
  assert.ok(errs[0].includes("workId is required"));
});

test("init provisions a token with no signup, saves it locally, and reports the workspace", async () => {
  const saved = [];
  const out = [];
  const code = await run(["init", "--label", "my-agent"], {
    provision: async ({ baseUrl, label }) => {
      assert.equal(baseUrl, "https://pullboard.dev", "defaults to the hosted board");
      assert.equal(label, "my-agent", "passes the --label through");
      return { token: "tok-123", workspaceId: "ws-9" };
    },
    saveConfig: (config) => saved.push(config),
    loadConfig: () => ({}),
    env: {},
    log: (m) => out.push(m),
  });
  assert.equal(code, 0);
  assert.deepEqual(saved[0], { baseUrl: "https://pullboard.dev", token: "tok-123" }, "persists baseUrl + token");
  assert.ok(out.some((m) => m.includes("ws-9")), "reports the new workspace id");
});

test("init fails closed and writes nothing when provisioning errors", async () => {
  const saved = [];
  const errs = [];
  const code = await run(["init"], {
    provision: async () => { throw new Error("anon-provision failed (503)"); },
    saveConfig: (config) => saved.push(config),
    loadConfig: () => ({}),
    env: {},
    error: (m) => errs.push(m),
  });
  assert.equal(code, 1);
  assert.equal(saved.length, 0, "no token written on failure");
  assert.ok(errs[0].includes("anon-provision failed"));
});

test("saved config supplies the base URL and token when flags and env are absent", async () => {
  let made;
  const out = [];
  const code = await run(["get", "item-3"], {
    env: {},
    loadConfig: () => ({ baseUrl: "https://board.example", token: "cfg-tok" }),
    makeClient: ({ baseUrl, token }) => { made = { baseUrl, token }; return { getItem: async (id) => ({ workId: id }) }; },
    log: (m) => out.push(m),
  });
  assert.equal(code, 0);
  assert.deepEqual(made, { baseUrl: "https://board.example", token: "cfg-tok" }, "config feeds the API client");
  assert.match(out[0], /"workId": "item-3"/);
});
