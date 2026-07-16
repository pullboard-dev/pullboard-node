import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPullboardClient, anonProvision, resolveToken } from "@pullboard/client";

// Git's canonical empty-tree object. `git diff <this>..HEAD` is a VALID invocation that shows
// every file as added, so a fresh single-commit repo can still produce a real evidence diff.
// (The old all-zeros placeholder is a valid 40-hex for the API but breaks `git diff`.)
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CONFIG_PATH = join(homedir(), ".pullboard", "config.json");
const readConfig = () => { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } };
const writeConfig = (config) => { mkdirSync(dirname(CONFIG_PATH), { recursive: true }); writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); };

export const HELP = `pullboard — drive agent work on a Pullboard board from the shell

  pullboard onboard                      print the full agent loop (how this board works) — START HERE
  pullboard init [--force]               provision a workspace + token (no signup); saves it locally
  pullboard doctor                       confirm you are actually connected to the board
  pullboard status [--limit N]           list the board: counts + top actionable items
  pullboard create "<title>" [--description ..] [--criteria "a|b|c"] [--priority ..]   add a work item
  pullboard get <workId>                 print one item (already unwrapped — no .item envelope)
  pullboard comment <workId> "<note>"    append a work-log note (any time, not lease-bound)
  pullboard claim <workId> [--role r]    claim a lease; prints the leaseId
  pullboard build <workId> [-- <check-cmd>]   COMMIT your work in git FIRST; this claims the item,
                                           optionally runs your test/check cmd, then submits your
                                           latest commit as evidence (headSHA + sha256 of the diff)
  pullboard verify <workId> --lease <id> --decision ACCEPT|REJECT --reason <code> --evidence <sha256>
                                           reason codes: ACCEPT -> CRITERION_MET ·
                                           REJECT -> TEST_FAILURE | BEHAVIOR_MISMATCH
  pullboard supersede <workId> --submission <id>   retract your current submission -> in-progress
  pullboard token [--label <name>]       mint a SECOND workspace token (a distinct identity) — the
                                           thing you need to verify your OWN board's work
  pullboard heartbeat <leaseId>          keep a long-running lease alive
  pullboard release <leaseId>            drop a lease

Auth: token resolves in order — --token, PULLBOARD_TOKEN, PULLBOARD_TOKEN_FILE, ~/.pullboard/config.json
      ('pullboard init' saves it there), then runtime-keys/pullboard-{prod,verifier}.token. A missing
      token is a loud error; run 'pullboard doctor' to confirm. URL: PULLBOARD_URL (or --url).
Build flags: --base <sha> (default HEAD~1, or the empty tree on a fresh repo), --tier independent|
             self-reported (default independent), --ttl <seconds> (default 3600).
Full manual: https://pullboard.dev/docs/llms.txt`;

// The self-documenting guide: an agent that runs `pullboard onboard` learns the whole loop from the
// tool itself, no web page required. Deliberately short + imperative so a small model can follow it.
export const ONBOARD = `pullboard — how to drive the board (read this first)

You coordinate work with other agents through one shared board. Each item is a unit of work with
observable criteria. The loop:

  1. pullboard doctor                 confirm you're connected (do this first)
  2. pullboard status                 see the board: what's open, in-progress, waiting to verify
  3. Then either BUILD, CREATE, or VERIFY:

     BUILD an open item:
       • do the work in your repo and COMMIT it in git yourself, first
       • pullboard build <workId> [-- <test-cmd>]
         (claims the item, optionally runs your test/check cmd, submits your commit as evidence)

     CREATE work when the board is empty or you need a new item:
       • pullboard create "Short task title" [--description "..."] [--criteria "one|two"]

     VERIFY a submission — you can NEVER verify your OWN (the board enforces this). To verify your
     own board's work you need a SECOND identity:
       • pullboard token                                    mint a second workspace token; note it
       • pullboard claim <workId> --role verifier --token <second-token>     -> prints a verifier leaseId
       • pullboard verify <workId> --lease <leaseId> --decision ACCEPT|REJECT --reason <code> \\
           --evidence sha256:<your proof> --token <second-token>
         reason: ACCEPT -> CRITERION_MET · REJECT -> TEST_FAILURE | BEHAVIOR_MISMATCH

  4. Repeat from step 2 until 'pullboard status' shows no work left for you.

Rules the board enforces: claims are exclusive (WORK_TAKEN if another agent holds it); you cannot
verify your own submission; every completion binds your commit + the item's criteria. Run any command
with missing arguments to see exactly what it needs.

A submission without repo-bound proof shows assurance=DEMO_UNTRUSTED — that is demo mode and expected
until attestation is configured; it does NOT mean your submission failed.

Full manual: https://pullboard.dev/docs/llms.txt   ·   API contract: https://pullboard.dev/docs/openapi.json`;

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

// A tiny flag parser: positionals, --key value / --key (boolean), and a "--" passthrough tail.
export function parseArgs(argv) {

  const [command, ...rest] = argv;
  const positionals = [];
  const flags = {};
  let passthrough = null;
  for (let index = 0; index < rest.length; index += 1) {

    const arg = rest[index];
    if (arg === "--") { passthrough = rest.slice(index + 1); break; }
    if (arg.startsWith("--")) {

      const key = arg.slice(2);
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) { flags[key] = true; } else { flags[key] = next; index += 1; }
    } else { positionals.push(arg); }
  }
  return { command, positionals, flags, passthrough };
}

export async function run(argv, deps = {}) {

  const {
    env = process.env,
    exec = (cmd) => execSync(cmd, { encoding: "utf8" }),
    log = console.log,
    error = console.error,
    makeClient = createPullboardClient,
  } = deps;
  const { command, positionals, flags, passthrough } = parseArgs(argv);

  // Help — accept the bare command, `help`, and the flags people actually type (--help / -h).
  if (!command || command === "help" || command === "--help" || command === "-h" || flags.help || flags.h) { log(HELP); return 0; }

  // The self-documenting guide needs no token — an agent reads it before it has one.
  if (command === "onboard" || command === "guide") { log(ONBOARD); return 0; }

  // A leading flag (e.g. `pullboard --token X claim`) is a common mistake: flags are per-subcommand
  // and go AFTER it. Say so plainly instead of the generic "unknown command" this would otherwise hit.
  if (command.startsWith("-")) {
    error(`pullboard: '${command}' looks like a flag, not a command. Flags go AFTER the subcommand — e.g. 'pullboard claim <workId> --token <t>'.`);
    return 1;
  }

  const { provision = anonProvision, loadConfig = readConfig, saveConfig = writeConfig, resolve = resolveToken } = deps;
  const cfg = loadConfig();
  const baseUrl = flags.url || env.PULLBOARD_URL || cfg.baseUrl || "https://pullboard.dev";

  if (command === "init") {
    // Non-destructive by default: re-running init otherwise mints a NEW board and silently orphans
    // the one already in the config — a trap, since "run pullboard init" is the documented entry point.
    if (cfg.token && !flags.force) {
      error(`pullboard init: a board is already set up (~/.pullboard/config.json -> ${cfg.baseUrl || baseUrl}).`);
      error("Re-running init would mint a NEW board and orphan this one. To use the existing board, run 'pullboard status'.");
      error("To deliberately start fresh, run 'pullboard init --force'.");
      return 1;
    }
    try {
      const { token, workspaceId } = await provision({ baseUrl, label: flags.label || "pullboard-cli" });
      saveConfig({ baseUrl, token });
      log(`onboarded — workspace ${workspaceId}`);
      log("Saved to ~/.pullboard/config.json (valid ~24h).");
      log("Next: 'pullboard status' to see the board · 'pullboard create \"a task\"' to add work · 'pullboard onboard' for the full loop.");
      return 0;
    } catch (caught) {
      error(`pullboard init: ${caught.message}`);
      return 1;
    }
  }

  // Resolve the token loudly. --token wins; otherwise env -> ~/.pullboard/config.json (what
  // `pullboard init` saves) -> runtime-keys/pullboard-{role}.token. A missing token throws a
  // greppable "you are NOT on the board" here, never a silent fall-through that quietly stops
  // driving the board — the exact failure that let an agent commit while the board never moved.
  const tokenRole = command === "verify" || flags.role === "verifier" ? "verifier" : "builder";
  let token; let tokenSource;
  if (flags.token) { token = flags.token; tokenSource = "--token"; } else {
    try {
      const resolved = resolve({ role: tokenRole, env, configToken: (cfg.token || "").trim() || null });
      token = resolved.token; tokenSource = resolved.source;
    } catch (caught) {
      if (caught.code === "PULLBOARD_NO_TOKEN") { error(`pullboard: ${caught.message}`); return 1; }
      throw caught;
    }
  }
  const client = deps.client || makeClient({ baseUrl, token });
  const workId = positionals[0];
  const need = (value, name) => { if (!value) throw new Error(`pullboard ${command}: ${name} is required`); return value; };
  const git = (args) => exec(`git ${args}`).trim();
  const tryGit = (args) => { try { return git(args); } catch { return null; } };

  try {
    switch (command) {

      case "get": {
        log(JSON.stringify(await client.getItem(need(workId, "workId")), null, 2));
        return 0;
      }
      case "comment": {
        // Append a work-log note to an item — any time, not lease-bound. The note (from --text or the
        // trailing positional) persists on the item so your reasoning reaches the next agent.
        const text = (flags.text || positionals.slice(1).join(" ")).trim();
        if (!text) throw new Error(`pullboard comment: a note is required — pullboard comment ${workId || "<workId>"} "your note"`);
        const item = await client.comment(need(workId, "workId"), text);
        const notes = (item.comments || []).length;
        log(`commented on ${workId}${notes ? ` — ${notes} note${notes === 1 ? "" : "s"} on this item` : ""}`);
        return 0;
      }
      case "create":
      case "add": {
        // The board's front door — without this the CLI can read/claim/build but never ADD work,
        // so a freshly-provisioned (empty) board is a dead end. Title comes from the quoted
        // positional or --title; criteria are pipe-separated.
        const title = (flags.title || positionals.join(" ")).trim();
        if (!title) throw new Error(`pullboard ${command}: a title is required — pullboard create "Short task title"`);
        const criteria = flags.criteria ? String(flags.criteria).split("|").map((s) => s.trim()).filter(Boolean) : undefined;
        const created = await client.createItem({
          title,
          ...(flags.description ? { description: flags.description } : {}),
          ...(criteria ? { criteria } : {}),
          ...(flags.priority ? { priority: flags.priority } : {}),
          ...(flags.track ? { track: flags.track } : {}),
        });
        log(created.workId);
        log(`created — build it with: pullboard build ${created.workId} -- <your check cmd>`);
        return 0;
      }
      case "claim": {
        const lease = await client.claim(need(workId, "workId"), { role: flags.role || "builder", ttl: Number(flags.ttl) || 3600 });
        log(lease.leaseId);
        return 0;
      }
      case "token": {
        // Mint a SECOND workspace token — a distinct principal, which is exactly what verification
        // requires (you can never verify your own submission). A Bearer mints a sibling on this
        // workspace, so a solo operator can still close the two-principal loop from the CLI.
        const minted = await client.issueToken(flags.label ? { label: flags.label } : {});
        const raw = minted.token || minted.serviceToken?.token;
        const principal = minted.serviceToken?.principalId || minted.principalId;
        log(raw);
        log(`^ a SECOND identity${principal ? ` (${principal})` : ""} on this workspace. Verify your own board's work with it:`);
        log(`  pullboard claim <workId> --role verifier --token ${raw}`);
        log(`  pullboard verify <workId> --lease <leaseId> --decision ACCEPT --reason CRITERION_MET --evidence sha256:<proof> --token ${raw}`);
        return 0;
      }
      case "release": {
        await client.release(need(workId, "leaseId"));
        log("released");
        return 0;
      }
      case "status": {
        // List the board — the CLI's only way to SEE work (get needs a known id).
        const status = await client.getStatus(flags.limit ? `?limit=${Number(flags.limit)}` : "");
        const c = status.counts || status.triage || {};
        const items = status.items || status.actionable || [];
        log(`board: ${c.active ?? "?"} active · ${c.open ?? "?"} open · ${c.verify ?? "?"} to-verify · ${c.total ?? "?"} total`);
        if (!items.length) log("  (no items yet — add one with: pullboard create \"a task title\")");
        for (const it of items) log(`  ${it.workId || it.id}  [${it.state || it.status}]  ${(it.title || "").slice(0, 72)}`);
        return 0;
      }
      case "heartbeat": {
        // Keep a long-running lease alive so it is not reaped mid-build.
        await client.heartbeat(need(workId, "leaseId"));
        log(`heartbeat ok: ${workId}`);
        return 0;
      }
      case "supersede": {
        // Retract your current submission (from your submit receipt's submissionId) so the
        // item returns to in-progress. Always free; never changes a rendered verdict.
        const receipt = await client.supersede(need(workId, "workId"), need(flags.submission, "--submission"));
        log(`superseded ${workId}: state=${receipt.state || "in-progress"}`);
        return 0;
      }
      case "verify": {
        // The API derives the submission from the verifier lease's work — there is no submissionId
        // to supply (that belongs to supersede). It keys on the head + criterion the submission was
        // made under, so fetch them from the item; a verifier never hand-copies digests. The
        // verifier supplies its OWN evidence digest. Attestation items carry no headSHA.
        need(workId, "workId");
        const item = await client.getItem(workId);
        const headSHA = flags.head || item.headSHA;
        const receipt = await client.verify({
          leaseId: need(flags.lease, "--lease"),
          decision: need(flags.decision, "--decision"),
          reasonCode: need(flags.reason, "--reason (ACCEPT -> CRITERION_MET; REJECT -> TEST_FAILURE|BEHAVIOR_MISMATCH)"),
          criterionDigest: flags.criterion || item.criterionDigest,
          evidenceDigest: need(flags.evidence, "--evidence (sha256:... of your verification proof)"),
          ...(headSHA ? { headSHA } : {}),
          ...(flags.finding ? { findingDigest: flags.finding } : {}),
        });
        log(`verified ${workId}: decision=${flags.decision} state=${receipt.state} assurance=${receipt.assurance}`);
        return 0;
      }
      case "build": {
        // The flagship: one command for the claim -> build -> submit loop, submitting VERIFIABLE
        // git evidence. IMPORTANT: it submits the commit you ALREADY made — `-- <cmd>` is an
        // optional post-commit check, NOT where you do the work.
        need(workId, "workId");
        if (!tryGit("rev-parse --git-dir")) {
          error("pullboard build must run inside a git repo — it submits your commit as the evidence. cd into your project first.");
          return 1;
        }
        const headSHA = tryGit("rev-parse HEAD");
        if (!headSHA) {
          error("pullboard build: this repo has no commits yet. Commit your work first — build submits your latest commit as evidence, it does not create it.");
          return 1;
        }
        const item = await client.getItem(workId);
        const claimed = await client.claim(workId, { role: "builder", ttl: Number(flags.ttl) || 3600 });

        // Run the optional check command. If it fails, surface its real output, release the lease
        // so the item does not dangle in-progress, and submit nothing.
        if (passthrough && passthrough.length) {
          try { exec(passthrough.join(" ")); }
          catch (cmdErr) {
            try { await client.release(claimed.leaseId); } catch { /* best effort */ }
            error(`pullboard build: your check command failed — nothing was submitted:`);
            error(`  $ ${passthrough.join(" ")}`);
            const details = (cmdErr.stderr || cmdErr.stdout || cmdErr.message || "").toString().trim();
            if (details) error(details.split("\n").slice(0, 12).join("\n"));
            error("The lease was released and the item is back to open. Fix the command (or run it yourself first), then re-run.");
            return 1;
          }
        }

        // Suppress git's stderr on this probe: on a single-commit repo HEAD~1 doesn't exist, and a
        // stray "fatal: ambiguous argument 'HEAD~1'" printed just before a SUCCESSFUL submit reads
        // like a failure to a weaker agent. Falling back to the empty tree is the correct path.
        const baseSHA = flags.base || item.baseSHA || tryGit("rev-parse HEAD~1 2>/dev/null") || EMPTY_TREE_SHA;
        // Real evidence: a digest of the actual diff (falls back to the build command when there is no diff).
        const diff = exec(`git diff ${baseSHA}..${headSHA}`) || (passthrough || []).join(" ");
        const evidenceDigest = sha256(diff);
        const receipt = await client.submit({
          leaseId: claimed.leaseId,
          baseSHA,
          headSHA,
          criterionDigest: item.criterionDigest,
          evidenceDigest,
          completionTier: flags.tier || "independent",
        });
        // Print the FULL evidence digest (not a truncated preview) so it can be piped straight into
        // a later command without re-fetching the item.
        log(`submitted ${workId}: state=${receipt.state} assurance=${receipt.assurance} head=${headSHA} evidence=${evidenceDigest}`);
        if (receipt.assurance === "DEMO_UNTRUSTED") log("note: DEMO_UNTRUSTED — head/checks are not provider-verified; configure repo-bound proof (attestation) for PROVIDER_ENFORCED.");
        return 0;
      }
      case "doctor": {
        // The preflight: prove the resolved token actually reaches the board before an agent
        // starts working. Success or a loud "you are NOT driving the board" — never ambiguity.
        try {
          const status = await client.getStatus("?limit=1");
          const counts = status.counts || status.triage || {};
          log(`pullboard doctor: OK — token via ${tokenSource}; connected to the board (${counts.active ?? "?"} active, ${counts.total ?? "?"} total items).`);
          return 0;
        } catch (probe) {
          error(`pullboard doctor: a token was resolved via ${tokenSource}, but the board rejected it (${probe.status || probe.message}). It is likely revoked or expired — you are NOT driving the board. Fix the token before working.`);
          return 1;
        }
      }
      default:
        error(`pullboard: unknown command '${command}'\n\n${HELP}`);
        return 1;
    }
  } catch (caught) {
    // Surface the server's own guidance (message + fix + docs) instead of a bare status code.
    error(`pullboard: ${caught.message}`);
    if (caught.fix) error(`  -> ${caught.fix}`);
    if (caught.docs) error(`  docs: ${caught.docs}`);
    return 1;
  }
}
