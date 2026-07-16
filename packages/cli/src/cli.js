import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPullboardClient, anonProvision } from "@pullboard/client";

const EMPTY_TREE_SHA = "0".repeat(40);
const CONFIG_PATH = join(homedir(), ".pullboard", "config.json");
const readConfig = () => { try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; } };
const writeConfig = (config) => { mkdirSync(dirname(CONFIG_PATH), { recursive: true }); writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); };

export const HELP = `pullboard — drive agent work on a Pullboard board from the shell

  pullboard init                         provision a workspace + token (no signup); saves it locally
  pullboard get <workId>                 print an item (already unwrapped — no .item envelope)
  pullboard claim <workId> [--role r]    claim a lease; prints the leaseId
  pullboard build <workId> [-- <cmd>]    claim -> run <cmd> -> submit, with REAL evidence:
                                           headSHA from git, evidenceDigest = sha256 of the diff
  pullboard verify <workId> --submission <id> --decision ACCEPT|REJECT --reason <code>
  pullboard release <leaseId>            drop a lease

Auth: run 'pullboard init' once (saves ~/.pullboard/config.json), or set PULLBOARD_TOKEN (or --token). URL: PULLBOARD_URL (or --url, default https://pullboard.dev).
Build flags: --base <sha> (default HEAD~1), --tier independent|self-reported (default independent),
             --ttl <seconds> (default 3600).`;

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

  if (!command || command === "help" || flags.help) { log(HELP); return 0; }

  const { provision = anonProvision, loadConfig = readConfig, saveConfig = writeConfig } = deps;
  const baseUrl = flags.url || env.PULLBOARD_URL || loadConfig().baseUrl || "https://pullboard.dev";

  if (command === "init") {
    try {
      const { token, workspaceId } = await provision({ baseUrl, label: flags.label || "pullboard-cli" });
      saveConfig({ baseUrl, token });
      log(`onboarded — workspace ${workspaceId}`);
      log("token saved to ~/.pullboard/config.json (valid ~24h). Now try: pullboard get <workId>  —  or  pullboard build <workId> -- <cmd>");
      return 0;
    } catch (caught) {
      error(`pullboard init: ${caught.message}`);
      return 1;
    }
  }

  const token = flags.token || env.PULLBOARD_TOKEN || loadConfig().token;
  if (!token) { error("pullboard: run 'pullboard init' first, or set PULLBOARD_TOKEN (or pass --token)"); return 1; }
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
      case "claim": {
        const lease = await client.claim(need(workId, "workId"), { role: flags.role || "builder", ttl: Number(flags.ttl) || 3600 });
        log(lease.leaseId);
        return 0;
      }
      case "release": {
        await client.release(need(workId, "leaseId"));
        log("released");
        return 0;
      }
      case "verify": {
        const receipt = await client.verify({
          leaseId: need(flags.lease, "--lease"),
          submissionId: need(flags.submission, "--submission"),
          decision: need(flags.decision, "--decision"),
          reasonCode: need(flags.reason, "--reason"),
          headSHA: flags.head,
          criterionDigest: flags.criterion,
          evidenceDigest: flags.evidence,
        });
        log(`verified ${workId || ""}: decision=${flags.decision} state=${receipt.state} assurance=${receipt.assurance}`);
        return 0;
      }
      case "build": {
        // The flagship: one command for the claim -> build -> submit loop Mimo did by hand,
        // and it submits VERIFIABLE evidence instead of a fabricated digest.
        need(workId, "workId");
        const item = await client.getItem(workId);
        const claimed = await client.claim(workId, { role: "builder", ttl: Number(flags.ttl) || 3600 });
        if (passthrough && passthrough.length) exec(passthrough.join(" "));

        const headSHA = git("rev-parse HEAD");
        const baseSHA = flags.base || item.baseSHA || tryGit("rev-parse HEAD~1") || EMPTY_TREE_SHA;
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
        log(`submitted ${workId}: state=${receipt.state} assurance=${receipt.assurance} head=${headSHA.slice(0, 8)} evidence=${evidenceDigest.slice(0, 19)}…`);
        if (receipt.assurance === "DEMO_UNTRUSTED") log("note: DEMO_UNTRUSTED — head/checks are not provider-verified; configure repo-bound proof (attestation) for PROVIDER_ENFORCED.");
        return 0;
      }
      default:
        error(`pullboard: unknown command '${command}'\n\n${HELP}`);
        return 1;
    }
  } catch (caught) {
    error(`pullboard: ${caught.message}`);
    return 1;
  }
}
