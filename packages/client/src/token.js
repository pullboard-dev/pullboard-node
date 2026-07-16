import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The conventional runtime-keys filename(s) per role. Builder falls back to the
// historical "prod" name so existing fleets keep working without a rename.
const ROLE_FILES = Object.freeze({
  builder: ["pullboard-builder.token", "pullboard-prod.token"],
  verifier: ["pullboard-verifier.token"],
});

// Walk up from `start` to the repository that declares its board (.pullboard/project.json).
// That file is committed on purpose, so it is the reliable anchor for "which board am I on".
function findProjectRoot(start, exists) {

  let dir = start;
  for (let depth = 0; depth < 64; depth += 1) {

    if (exists(join(dir, ".pullboard", "project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Read the workspace id the project declares, for a legible failure message. Never a secret.
function declaredWorkspace(root, exists, read) {

  const path = join(root, ".pullboard", "project.json");
  if (!exists(path)) return null;
  try {
    return JSON.parse(read(path)).workspace || null;
  } catch {
    return null;
  }
}

/**
 * Resolve this agent's Pullboard bearer token from the first source that has one:
 *   1. PULLBOARD_TOKEN                 (explicit env, wins)
 *   2. PULLBOARD_TOKEN_FILE            (explicit path)
 *   3. configToken                     (~/.pullboard/config.json — what `pullboard init` saves)
 *   4. <repo>/runtime-keys/pullboard-{role}.token   (conventional fleet key, gitignored)
 *
 * `configToken` is passed in already-loaded (the CLI owns ~/.pullboard/config.json and its
 * injectable loader) so this resolver stays free of home-directory IO and fully testable.
 *
 * There is no silent empty return: an agent that cannot resolve a token throws a loud,
 * greppable error naming the board it is NOT connected to and every source it checked, so
 * "work committed to git but the board never moved" can never happen quietly again.
 *
 * @returns {{token: string, source: string, workspace: string|null}}
 */
export function resolveToken({
  role = "builder",
  env = process.env,
  cwd = process.cwd(),
  exists = existsSync,
  read = (path) => readFileSync(path, "utf8"),
  configToken = null,
  configSource = "config:~/.pullboard/config.json",
} = {}) {

  const checked = [];
  const root = findProjectRoot(cwd, exists);
  const workspace = root ? declaredWorkspace(root, exists, read) : null;

  const envToken = (env.PULLBOARD_TOKEN || "").trim();
  if (envToken) return { token: envToken, source: "env:PULLBOARD_TOKEN", workspace };
  checked.push("env PULLBOARD_TOKEN");

  if (env.PULLBOARD_TOKEN_FILE) {
    checked.push(`env PULLBOARD_TOKEN_FILE (${env.PULLBOARD_TOKEN_FILE})`);
    if (exists(env.PULLBOARD_TOKEN_FILE)) {
      const fromFile = read(env.PULLBOARD_TOKEN_FILE).trim();
      if (fromFile) return { token: fromFile, source: "env:PULLBOARD_TOKEN_FILE", workspace };
    }
  }

  const fromConfig = (configToken || "").trim();
  if (fromConfig) return { token: fromConfig, source: configSource, workspace };
  checked.push("~/.pullboard/config.json (run `pullboard init`)");

  if (root) {
    for (const name of ROLE_FILES[role] || ROLE_FILES.builder) {
      const path = join(root, "runtime-keys", name);
      checked.push(path);
      if (exists(path)) {
        const fromFile = read(path).trim();
        if (fromFile) return { token: fromFile, source: `file:${path}`, workspace };
      }
    }
  }

  const target = workspace ? `board ${workspace}` : "any Pullboard board";
  const error = new Error(
    `No Pullboard ${role} token — you are NOT connected to ${target}; work will not be tracked. ` +
    `Set PULLBOARD_TOKEN, or PULLBOARD_TOKEN_FILE, run \`pullboard init\`, or place the token at runtime-keys/pullboard-${role === "verifier" ? "verifier" : "prod"}.token. ` +
    `Checked: ${checked.join("; ")}.`,
  );
  error.code = "PULLBOARD_NO_TOKEN";
  throw error;
}
