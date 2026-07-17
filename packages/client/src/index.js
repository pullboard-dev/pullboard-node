import { randomUUID } from "node:crypto";

export { resolveToken } from "./token.js";

// Hosts for which plaintext http:// is tolerated — a developer running the API on their own
// machine. Anything else MUST be https://, because every request carries the bearer token in an
// Authorization header and http:// to a remote host puts that token on the wire in cleartext (and
// invites a downgrade/redirect to an attacker-chosen destination).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Reject a baseUrl that would leak the bearer token to an insecure or unexpected destination.
 * https:// is always allowed; http:// is allowed ONLY for a loopback host (local dev). Every other
 * scheme (http:// to a remote host, and non-http(s) schemes like file://, ftp://, ws://) throws.
 *
 * @param {string} baseUrl - The configured base URL the token would be sent to.
 * @returns {string} The same baseUrl when it is safe.
 */
export function assertSafeBaseUrl(baseUrl) {

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`Pullboard baseUrl must be an absolute URL, received: ${JSON.stringify(baseUrl)}`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return baseUrl;
  throw new TypeError(
    `Pullboard refuses to send your bearer token to ${url.protocol}//${url.host} — use https:// ` +
    "(plain http:// is allowed only for localhost/127.0.0.1 during development).",
  );
}

/**
 * Create a token-authenticated client for Pullboard's coordination API.
 *
 * @param {object} options Base URL, token, and injectable request dependencies.
 * @returns {object} Frozen client operation surface.
 */
export function createPullboardClient({ baseUrl, token, fetchImpl = fetch, requestId = randomUUID }) {

  // Requests cannot be scoped or authenticated without both required values.
  if (!baseUrl || !token) throw new TypeError("baseUrl and token are required");

  // The shared choke point: every authenticated operation flows through here, so validating the
  // destination once guarantees the token is never sent to an http:// remote or a non-web scheme.
  assertSafeBaseUrl(baseUrl);

  // Normalize one trailing slash so every operation can append an absolute API path.
  const origin = baseUrl.replace(/\/$/, "");

  /**
   * Issue one authenticated API request and project stable error metadata.
   *
   * @param {string} path Absolute API path.
   * @param {object} [options] Request method and optional JSON body.
   * @returns {Promise<object>} Parsed successful response payload.
   */
  async function call(path, { method = "GET", body } = {}) {

    // Add JSON headers and serialization only when a body is present.
    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Pullboard responses use JSON for both success and stable error envelopes.
    const payload = await response.json();

    // Convert unsuccessful envelopes into errors while retaining machine metadata.
    if (!response.ok) {

      // Prefer the served message, then code, before the status fallback.
      const error = new Error(payload.message || payload.error || `Pullboard request failed (${response.status})`);

      // Preserve HTTP status for programmatic recovery decisions.
      error.status = response.status;

      // Preserve the stable Pullboard error code when supplied.
      error.code = payload.error;

      // Preserve the server's own remediation guidance so callers can print it verbatim.
      if (payload.fix) error.fix = payload.fix;
      if (payload.docs) error.docs = payload.docs;

      // Reject the operation with the enriched client error.
      throw error;
    }

    // Successful operations expose the parsed response unchanged.
    return payload;
  }

  /**
   * Preserve a caller request ID or generate one for mutation replay safety.
   *
   * @param {object} input Mutation payload.
   * @returns {object} Payload with a request ID.
   */
  const withRequestId = (input) => ({ ...input, requestId: input.requestId || requestId() });

  // Publish the complete client surface without allowing operation replacement.
  return Object.freeze({
    getStatus: (query = "") => call(`/api/status${query}`),
    getItem: async (workId) => (await call(`/api/items/${encodeURIComponent(workId)}`)).item,
    createItem: async (input) => (await call("/api/items", { method: "POST", body: withRequestId(input) })).item,
    claim: (workId, { role = "builder", ttl = 3600, ...input } = {}) =>
      call("/api/claim", { method: "POST", body: withRequestId({ workId, role, ttl, ...input }) }),
    heartbeat: (leaseId, input = {}) =>
      call("/api/lease", { method: "POST", body: withRequestId({ action: "heartbeat", leaseId, ...input }) }),
    release: (leaseId, input = {}) =>
      call("/api/lease", { method: "POST", body: withRequestId({ action: "release", leaseId, ...input }) }),
    submit: (input) => call("/api/submit", { method: "POST", body: withRequestId(input) }),
    supersede: (workId, submissionId, input = {}) =>
      call("/api/supersede", { method: "POST", body: withRequestId({ workId, submissionId, ...input }) }),
    verify: (input) => call("/api/verify", { method: "POST", body: withRequestId(input) }),
    // Comments are append-only work-log notes — not lease-bound, allowed in any state. The route
    // rejects requestId (each call adds a distinct note), so send ONLY { text }. Returns the item
    // detail with its comment thread.
    comment: (workId, text) => call(`/api/items/${encodeURIComponent(workId)}/comments`, { method: "POST", body: { text } }),
    // Token issuance uses STRICT_INPUT and is not requestId-idempotent — send ONLY the documented
    // fields (an optional label); adding a requestId is rejected as an extra field.
    issueToken: (input = {}) => call("/api/accounts/tokens", { method: "POST", body: input }),
    patchItem: async (workId, changes, input = {}) => {

      // Read the current item version before constructing an optimistic patch.
      const item = await (async () => (await call(`/api/items/${encodeURIComponent(workId)}`)).item)();

      // Bind the patch to the fetched update timestamp.
      return call(`/api/items/${encodeURIComponent(workId)}`, {
        method: "PATCH",
        body: withRequestId({ ...changes, ...input, expectedUpdatedAt: item.updatedAt }),
      });
    },
    transitionItem: async (workId, action, input = {}) => {

      // Read the current item version before constructing an optimistic transition.
      const item = await (async () => (await call(`/api/items/${encodeURIComponent(workId)}`)).item)();

      // Bind the transition to the fetched update timestamp.
      return call(`/api/items/${encodeURIComponent(workId)}/state`, {
        method: "POST",
        body: withRequestId({ action, ...input, expectedUpdatedAt: item.updatedAt }),
      });
    },
  });
}

/**
 * Provision a fresh anonymous workspace and a one-time bearer token — no signup.
 * This is the token-less onboarding call (POST /api/accounts/anon-provision); every other
 * client operation requires the token it returns.
 *
 * @param {object} [options] Base URL, workspace label, and an injectable fetch.
 * @returns {Promise<{token: string, workspaceId: string}>} The new token and workspace id.
 */
export async function anonProvision({ baseUrl = "https://pullboard.dev", label = "pullboard-cli", fetchImpl = fetch } = {}) {

  // Onboarding sends no bearer token, but it RECEIVES one — guard the destination before we ask a
  // server to mint a token we would then store, so a misconfigured http:// URL cannot phish it.
  assertSafeBaseUrl(baseUrl);
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/accounts/anon-provision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `anon-provision failed (${response.status})`);
    error.status = response.status;
    error.code = payload.error;
    throw error;
  }
  return { token: payload.token, workspaceId: payload.workspace?.workspaceId };
}
