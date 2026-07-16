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
    getStatus: async (query) => { calls.push(["getStatus", query]); if (overrides.statusThrows) throw Object.assign(new Error("rejected"), { status: 401 }); return { counts: { active: 5, total: 10 }, ...overrides.status }; },
    getItem: async (id) => { calls.push(["getItem", id]); return { workId: id, criterionDigest: "sha256:crit", baseSHA: null, headSHA: "h".repeat(40), ...overrides.item }; },
    claim: async (id, opts) => { calls.push(["claim", id, opts]); return { leaseId: "lease-1" }; },
    submit: async (input) => { calls.push(["submit", input]); return { state: "pending-verify", assurance: "DEMO_UNTRUSTED", ...overrides.submit }; },
    verify: async (input) => { calls.push(["verify", input]); return { state: "closed", assurance: "DEMO_UNTRUSTED" }; },
    supersede: async (id, sub) => { calls.push(["supersede", id, sub]); return { workId: id, state: "in-progress" }; },
    heartbeat: async (id) => { calls.push(["heartbeat", id]); return { ok: true }; },
    release: async (id) => { calls.push(["release", id]); return { released: true }; },
    createItem: async (input) => { calls.push(["createItem", input]); return { workId: overrides.createdWorkId || "new-item", ...overrides.created }; },
    issueToken: async (input) => { calls.push(["issueToken", input]); return { token: overrides.mintedToken || "tok-2", serviceToken: { principalId: "agent:second" } }; },
  };
}

// A git exec stub: answers the build preflight (git-dir + HEAD) and lets each test override diffs.
function gitExec(extra = () => undefined) {
  return (cmd) => {
    if (cmd === "git rev-parse --git-dir") return ".git\n";
    const override = extra(cmd);
    if (override !== undefined) return override;
    return "";
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
    if (cmd === "git rev-parse --git-dir") return ".git\n";
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
    if (cmd === "git rev-parse --git-dir") return ".git";
    if (cmd === "git rev-parse HEAD") return "a".repeat(40);
    if (cmd.startsWith("git rev-parse HEAD~1")) throw new Error("no prior commit");
    if (cmd.startsWith("git diff")) return ""; // no diff -> evidence falls back to the command text
    return "";
  };
  const out = [];
  await run(["build", "item-1", "--tier", "self-reported", "--", "make"], { client, exec, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  const submit = client.calls.find(([name]) => name === "submit")[1];
  assert.equal(submit.completionTier, "self-reported");
  assert.equal(submit.baseSHA, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "git's real empty-tree base when HEAD~1 is unavailable");
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
  await run(["verify", "item-2", "--lease", "L", "--decision", "ACCEPT", "--reason", "CRITERION_MET", "--evidence", `sha256:${"e".repeat(64)}`], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.match(out[0], /decision=ACCEPT/);
  const vinput = client.calls.find(([n]) => n === "verify")[1];
  assert.equal(vinput.leaseId, "L");
  assert.equal(vinput.reasonCode, "CRITERION_MET");
  assert.equal(vinput.criterionDigest, "sha256:crit", "criterion comes from the fetched item, not a hand-copied flag");
  assert.equal(vinput.evidenceDigest, `sha256:${"e".repeat(64)}`, "verifier supplies its own evidence digest");
  assert.equal(vinput.headSHA, "h".repeat(40), "head comes from the fetched item");
  assert.ok(!("submissionId" in vinput), "no spurious submissionId — the API keys verify on the lease's work");
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

test("doctor confirms the token reaches the board, or fails loud", async () => {
  const out = [];
  const ok = await run(["doctor"], { client: stubClient(), env: { PULLBOARD_TOKEN: "t" }, loadConfig: () => ({}), log: (m) => out.push(m) });
  assert.equal(ok, 0);
  assert.match(out[0], /doctor: OK/);
  assert.match(out[0], /5 active, 10 total/);
  // A resolved-but-rejected token (revoked/expired) fails loud, not silent.
  const errs = [];
  const bad = await run(["doctor"], { client: stubClient({ statusThrows: true }), env: { PULLBOARD_TOKEN: "t" }, loadConfig: () => ({}), error: (m) => errs.push(m) });
  assert.equal(bad, 1);
  assert.match(errs[0], /NOT driving the board/);
});

test("a missing token fails LOUD via the resolver, never a silent skip", async () => {
  // Inject a resolver that throws PULLBOARD_NO_TOKEN so the assertion is machine-independent.
  const noToken = () => { throw Object.assign(new Error("No Pullboard builder token — you are NOT connected to board ws; set PULLBOARD_TOKEN or place it at runtime-keys/."), { code: "PULLBOARD_NO_TOKEN" }); };
  const errs = [];
  const code = await run(["get", "x"], { env: {}, loadConfig: () => ({}), resolve: noToken, error: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.ok(errs[0].includes("NOT connected") && errs[0].includes("PULLBOARD_TOKEN"));
});

test("status lists board counts and items; heartbeat and supersede map to the SDK", async () => {
  const client = stubClient({ status: { counts: { active: 5, open: 3, verify: 1, total: 12 }, items: [{ workId: "w-1", state: "open", title: "First thing" }] } });
  const out = [];
  await run(["status", "--limit", "5"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.match(out[0], /5 active · 3 open · 1 to-verify · 12 total/);
  assert.match(out[1], /w-1\s+\[open\]\s+First thing/);
  assert.equal(client.calls.find(([n]) => n === "getStatus")[1], "?limit=5");
  out.length = 0;
  await run(["heartbeat", "lease-42"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.match(out[0], /heartbeat ok: lease-42/);
  assert.equal(client.calls.find(([n]) => n === "heartbeat")[1], "lease-42");
  out.length = 0;
  await run(["supersede", "w-9", "--submission", "sub-3"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.match(out[0], /superseded w-9: state=in-progress/);
  assert.deepEqual(client.calls.find(([n]) => n === "supersede").slice(1), ["w-9", "sub-3"]);
  // supersede without --submission fails closed.
  const errs = [];
  assert.equal(await run(["supersede", "w-9"], { client, env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs.push(m) }), 1);
  assert.ok(errs[0].includes("--submission is required"));
})

test("create adds an item, parses pipe-separated criteria, and prints the new workId first", async () => {
  const client = stubClient();
  const out = [];
  const code = await run(["create", "My new task", "--criteria", "does a|does b", "--priority", "next"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.equal(code, 0);
  const input = client.calls.find(([n]) => n === "createItem")[1];
  assert.equal(input.title, "My new task", "title comes from the positional words");
  assert.deepEqual(input.criteria, ["does a", "does b"], "pipe-separated criteria become an array");
  assert.equal(input.priority, "next");
  assert.equal(out[0], "new-item", "prints the workId first so it is scriptable");
  // create with no title fails closed with a usable hint.
  const errs = [];
  assert.equal(await run(["create"], { client, env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs.push(m) }), 1);
  assert.ok(errs[0].includes("title is required"));
});

test("onboard prints the agent loop and needs no token", async () => {
  const out = [];
  // No client, no token, no config — an agent reads this before it has any of those.
  const code = await run(["onboard"], { env: {}, log: (m) => out.push(m) });
  assert.equal(code, 0);
  assert.match(out[0], /how to drive the board/i);
  assert.match(out[0], /pullboard status/);
  assert.match(out[0], /pullboard create/);
  assert.match(out[0], /verify your own/i, "warns you cannot verify your own work");
});

test("--help and -h print help, not 'unknown command'", async () => {
  for (const arg of ["--help", "-h"]) {
    const out = [];
    assert.equal(await run([arg], { env: {}, log: (m) => out.push(m) }), 0);
    assert.equal(out[0], HELP);
  }
});

test("init refuses to clobber an existing board unless --force", async () => {
  const saved = [];
  const errs = [];
  const code = await run(["init"], {
    loadConfig: () => ({ baseUrl: "https://pullboard.dev", token: "existing" }),
    provision: async () => { throw new Error("provision must NOT be called when a board already exists"); },
    saveConfig: (c) => saved.push(c),
    env: {},
    error: (m) => errs.push(m),
  });
  assert.equal(code, 1);
  assert.equal(saved.length, 0, "the existing board is not overwritten");
  assert.ok(errs.some((m) => m.includes("already set up")));
  assert.ok(errs.some((m) => m.includes("--force")), "tells you how to intentionally start fresh");
  // --force provisions a fresh board.
  const saved2 = [];
  const ok = await run(["init", "--force"], {
    loadConfig: () => ({ token: "existing" }),
    provision: async () => ({ token: "new-tok", workspaceId: "ws-new" }),
    saveConfig: (c) => saved2.push(c),
    env: {},
    log: () => {},
  });
  assert.equal(ok, 0);
  assert.equal(saved2[0].token, "new-tok", "--force starts a fresh board");
});

test("build releases the lease and submits nothing when the check command fails", async () => {
  const client = stubClient();
  const exec = (cmd) => {
    if (cmd === "git rev-parse --git-dir") return ".git";
    if (cmd === "git rev-parse HEAD") return "a".repeat(40);
    if (cmd.startsWith("git ")) return "";
    // the -- check command fails, carrying real stderr like execSync does.
    throw Object.assign(new Error("Command failed"), { stderr: "npm ERR! test failed\n" });
  };
  const errs = [];
  const code = await run(["build", "item-x", "--", "npm", "test"], { client, exec, env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.ok(client.calls.some(([n]) => n === "release"), "the lease is released so the item does not dangle in-progress");
  assert.ok(!client.calls.some(([n]) => n === "submit"), "nothing is submitted when the check fails");
  assert.ok(errs.join("\n").includes("test failed"), "surfaces the command's real stderr");
});

test("build fails clearly outside a git repo instead of a cryptic git error", async () => {
  const client = stubClient();
  const exec = (cmd) => { if (cmd === "git rev-parse --git-dir") throw new Error("not a git repository"); return ""; };
  const errs = [];
  const code = await run(["build", "item-x", "--", "true"], { client, exec, env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.ok(errs[0].includes("must run inside a git repo"));
  assert.ok(!client.calls.some(([n]) => n === "claim"), "does not claim before the git preflight passes");
});

test("token mints a second identity and shows how to verify your own work with it", async () => {
  const client = stubClient();
  const out = [];
  const code = await run(["token", "--label", "verifier"], { client, env: { PULLBOARD_TOKEN: "t" }, log: (m) => out.push(m) });
  assert.equal(code, 0);
  assert.equal(client.calls.find(([n]) => n === "issueToken")[1].label, "verifier");
  assert.equal(out[0], "tok-2", "prints the raw token first so it is scriptable");
  const joined = out.join("\n");
  assert.ok(joined.includes("--role verifier"), "shows how to claim as the verifier with it");
  assert.ok(joined.includes("pullboard verify"), "shows the verify call");
});

test("a leading flag before the subcommand gives a clear order hint", async () => {
  const errs = [];
  const code = await run(["--token", "abc", "claim", "x"], { env: {}, loadConfig: () => ({}), error: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.ok(errs[0].includes("looks like a flag"), "explains flags go after the subcommand");
});

test("errors surface the server's own fix and docs guidance", async () => {
  const client = {
    getItem: async () => { throw Object.assign(new Error("verification request has multiple invalid fields"), { status: 400, fix: "GET the item and copy its criterionDigest verbatim", docs: "https://pullboard.dev/errors/INVALID_INPUT" }); },
  };
  const errs = [];
  const code = await run(["get", "item-1"], { client, env: { PULLBOARD_TOKEN: "t" }, error: (m) => errs.push(m) });
  assert.equal(code, 1);
  const joined = errs.join("\n");
  assert.ok(joined.includes("multiple invalid fields"), "shows the message");
  assert.ok(joined.includes("copy its criterionDigest"), "shows the server's fix");
  assert.ok(joined.includes("/errors/"), "shows the docs link");
});
