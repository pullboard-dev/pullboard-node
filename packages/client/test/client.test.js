import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { anonProvision, assertSafeBaseUrl, createPullboardClient } from "../src/index.js";

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

describe("client", () => {
    test("generates request ids and supplies claim defaults", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test/", token: "secret", requestId: () => "generated-id",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ leaseId: "lease" }); },
        });
        await client.claim("work");
        assert.equal(calls[0].url, "https://pullboard.test/api/claim");
        assert.deepEqual(JSON.parse(calls[0].init.body), { workId: "work", role: "builder", ttl: 3600, requestId: "generated-id" });
        assert.equal(calls[0].init.headers.authorization, "Bearer secret");
    });

    test("fetch-then-patch supplies the current optimistic version", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret", requestId: () => "patch-id",
            fetchImpl: async (url, init) => {
                calls.push({ url, init });
                return calls.length === 1 ? response({ item: { updatedAt: "version-7" } }) : response({ item: { title: "Clearer" } });
            },
        });
        await client.patchItem("work/one", { title: "Clearer" });
        assert.equal(calls[0].url, "https://pullboard.test/api/items/work%2Fone");
        assert.deepEqual(JSON.parse(calls[1].init.body), { title: "Clearer", expectedUpdatedAt: "version-7", requestId: "patch-id" });
    });

    test("getStatus GETs /api/status with the query verbatim and returns the payload unwrapped", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ counts: { active: 5, total: 10 } }); },
        });
        const status = await client.getStatus("?limit=1");
        assert.equal(calls[0].url, "https://pullboard.test/api/status?limit=1");
        assert.equal(calls[0].init.method, "GET");
        assert.equal(calls[0].init.headers.authorization, "Bearer secret");
        // Status is a top-level payload — unlike getItem it is NOT unwrapped from an envelope.
        assert.deepEqual(status, { counts: { active: 5, total: 10 } });
        // Default (no query) hits the bare path.
        await client.getStatus();
        assert.equal(calls[1].url, "https://pullboard.test/api/status");
    });

    test("supersede POSTs workId + submissionId with a generated requestId", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret", requestId: () => "sup-id",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ workId: "w", state: "in-progress" }); },
        });
        await client.supersede("work/one", "submission-9");
        assert.equal(calls[0].url, "https://pullboard.test/api/supersede");
        assert.equal(calls[0].init.method, "POST");
        assert.deepEqual(JSON.parse(calls[0].init.body), { workId: "work/one", submissionId: "submission-9", requestId: "sup-id" });
    });

    test("surfaces stable API error metadata", async () => {
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret",
            fetchImpl: async () => response({ error: "WORK_TAKEN", message: "held" }, 409),
        });
        await assert.rejects(client.claim("work"), (error) => error.code === "WORK_TAKEN" && error.status === 409);
    });

    test("preserves the server's fix and docs guidance on errors", async () => {
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret",
            fetchImpl: async () => response({ error: "INVALID_INPUT", message: "bad", fix: "do X", docs: "/errors/INVALID_INPUT" }, 400),
        });
        await assert.rejects(client.claim("work"), (error) => error.fix === "do X" && error.docs === "/errors/INVALID_INPUT");
    });

    test("issueToken mints a sibling workspace token via /api/accounts/tokens", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret", requestId: () => "tok-id",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ token: "new-token", serviceToken: { principalId: "agent:2" } }); },
        });
        const minted = await client.issueToken({ label: "verifier" });
        assert.equal(calls[0].url, "https://pullboard.test/api/accounts/tokens");
        assert.equal(calls[0].init.method, "POST");
        assert.deepEqual(JSON.parse(calls[0].init.body), { label: "verifier" }, "STRICT_INPUT: no requestId extra");
        assert.equal(minted.token, "new-token");
    });

    test("createItem posts to /api/items with a request id and unwraps the item", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret", requestId: () => "create-id",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ item: { workId: "new-1" } }); },
        });
        const item = await client.createItem({ title: "A task", criteria: ["one"] });
        assert.equal(calls[0].url, "https://pullboard.test/api/items");
        assert.equal(calls[0].init.method, "POST");
        assert.deepEqual(JSON.parse(calls[0].init.body), { title: "A task", criteria: ["one"], requestId: "create-id" });
        assert.deepEqual(item, { workId: "new-1" }, "returns the unwrapped item");
    });

    test("comment posts only text to /api/items/{workId}/comments (append-only, no requestId)", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret", requestId: () => "unused",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ workId: "note-1", comments: [{ commentId: "c1", text: "hi" }] }); },
        });
        const item = await client.comment("note-1", "hi");
        assert.equal(calls[0].url, "https://pullboard.test/api/items/note-1/comments");
        assert.equal(calls[0].init.method, "POST");
        assert.deepEqual(JSON.parse(calls[0].init.body), { text: "hi" }, "append-only: text only, no requestId");
        assert.equal(item.comments.length, 1);
    });

    test("claim, submit, and verify happy path needs no request-id retry", async () => {
        const bodies = [];
        let id = 0;
        const client = createPullboardClient({
            baseUrl: "https://pullboard.test", token: "secret", requestId: () => `request-${++id}`,
            fetchImpl: async (_url, init) => {
                const body = JSON.parse(init.body);
                bodies.push(body);
                if (body.role) return response({ leaseId: body.role === "builder" ? "build-lease" : "verify-lease" });
                if (body.baseSHA) return response({ submissionId: "submission", headSHA: body.headSHA });
                return response({ decision: body.decision });
            },
        });
        const criterionDigest = `sha256:${"a".repeat(64)}`;
        const build = await client.claim("work");
        const submission = await client.submit({
            leaseId: build.leaseId, baseSHA: "0".repeat(40), headSHA: "1".repeat(40),
            criterionDigest, evidenceDigest: `sha256:${"b".repeat(64)}`,
        });
        const review = await client.claim("work", { role: "verifier" });
        await client.verify({
            leaseId: review.leaseId, submissionId: submission.submissionId, decision: "ACCEPT",
            headSHA: submission.headSHA, criterionDigest, evidenceDigest: `sha256:${"c".repeat(64)}`,
            reasonCode: "CRITERION_MET",
        });
        assert.deepEqual(bodies.map((body) => body.requestId), ["request-1", "request-2", "request-3", "request-4"]);
        assert.deepEqual(bodies.map((body) => body.role || body.decision || (body.baseSHA && "submit")), ["builder", "submit", "verifier", "ACCEPT"]);
    });
});

describe("anonProvision", () => {
    test("provisions a workspace token with no auth header and returns token + workspaceId", async () => {
        const calls = [];
        const { token, workspaceId } = await anonProvision({
            baseUrl: "https://pullboard.test/",
            label: "my-agent",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ token: "tok-1", workspace: { workspaceId: "ws-1" } }); },
        });
        assert.equal(calls[0].url, "https://pullboard.test/api/accounts/anon-provision", "normalizes the trailing slash");
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.headers.authorization, undefined, "onboarding needs no bearer token");
        assert.deepEqual(JSON.parse(calls[0].init.body), { label: "my-agent" });
        assert.deepEqual({ token, workspaceId }, { token: "tok-1", workspaceId: "ws-1" });
    });

    test("throws stable error metadata when provisioning is refused", async () => {
        await assert.rejects(
            anonProvision({ baseUrl: "https://pullboard.test", fetchImpl: async () => response({ error: "RATE_LIMITED", message: "slow down" }, 429) }),
            (error) => error.code === "RATE_LIMITED" && error.status === 429 && error.message === "slow down",
        );
    });
});

describe("baseUrl destination guard (finding #4 — token never sent to an insecure destination)", () => {
    const noFetch = async () => { throw new Error("fetch must never run for a rejected baseUrl"); };

    test("createPullboardClient rejects http:// to a remote host so the bearer token is never sent in cleartext", () => {
        assert.throws(
            () => createPullboardClient({ baseUrl: "http://evil.example", token: "secret", fetchImpl: noFetch }),
            (error) => error instanceof TypeError && /refuses to send your bearer token/.test(error.message) && /http:\/\/evil\.example/.test(error.message),
        );
    });

    test("createPullboardClient rejects a non-web scheme (file://) outright", () => {
        assert.throws(
            () => createPullboardClient({ baseUrl: "file:///etc/passwd", token: "secret", fetchImpl: noFetch }),
            (error) => error instanceof TypeError && /refuses to send your bearer token/.test(error.message),
        );
    });

    test("createPullboardClient allows https:// and http://localhost + http://127.0.0.1 (dev)", async () => {
        // https anywhere is fine.
        assert.doesNotThrow(() => createPullboardClient({ baseUrl: "https://pullboard.dev", token: "secret", fetchImpl: noFetch }));
        // http is tolerated only for loopback dev hosts — and a real request works.
        for (const dev of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
            const calls = [];
            const client = createPullboardClient({ baseUrl: dev, token: "secret", fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ counts: {} }); } });
            await client.getStatus();
            assert.equal(calls[0].url, `${dev}/api/status`, "the loopback dev URL is used verbatim");
        }
    });

    test("anonProvision applies the same guard and never fetches a rejected destination", async () => {
        await assert.rejects(
            anonProvision({ baseUrl: "http://evil.example", fetchImpl: noFetch }),
            (error) => error instanceof TypeError && /refuses to send your bearer token/.test(error.message),
        );
        // https onboarding still works.
        const { token } = await anonProvision({ baseUrl: "https://pullboard.dev", fetchImpl: async () => response({ token: "tok-1", workspace: { workspaceId: "ws-1" } }) });
        assert.equal(token, "tok-1");
    });

    test("assertSafeBaseUrl throws a clear TypeError for a malformed URL", () => {
        assert.throws(() => assertSafeBaseUrl("not a url"), (error) => error instanceof TypeError && /must be an absolute URL/.test(error.message));
    });
});
