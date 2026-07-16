import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { anonProvision, createPullboardClient } from "../src/index.js";

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

describe("client", () => {
    test("generates request ids and supplies claim defaults", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "http://pullboard.test/", token: "secret", requestId: () => "generated-id",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ leaseId: "lease" }); },
        });
        await client.claim("work");
        assert.equal(calls[0].url, "http://pullboard.test/api/claim");
        assert.deepEqual(JSON.parse(calls[0].init.body), { workId: "work", role: "builder", ttl: 3600, requestId: "generated-id" });
        assert.equal(calls[0].init.headers.authorization, "Bearer secret");
    });

    test("fetch-then-patch supplies the current optimistic version", async () => {
        const calls = [];
        const client = createPullboardClient({
            baseUrl: "http://pullboard.test", token: "secret", requestId: () => "patch-id",
            fetchImpl: async (url, init) => {
                calls.push({ url, init });
                return calls.length === 1 ? response({ item: { updatedAt: "version-7" } }) : response({ item: { title: "Clearer" } });
            },
        });
        await client.patchItem("work/one", { title: "Clearer" });
        assert.equal(calls[0].url, "http://pullboard.test/api/items/work%2Fone");
        assert.deepEqual(JSON.parse(calls[1].init.body), { title: "Clearer", expectedUpdatedAt: "version-7", requestId: "patch-id" });
    });

    test("surfaces stable API error metadata", async () => {
        const client = createPullboardClient({
            baseUrl: "http://pullboard.test", token: "secret",
            fetchImpl: async () => response({ error: "WORK_TAKEN", message: "held" }, 409),
        });
        await assert.rejects(client.claim("work"), (error) => error.code === "WORK_TAKEN" && error.status === 409);
    });

    test("claim, submit, and verify happy path needs no request-id retry", async () => {
        const bodies = [];
        let id = 0;
        const client = createPullboardClient({
            baseUrl: "http://pullboard.test", token: "secret", requestId: () => `request-${++id}`,
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
            baseUrl: "http://pullboard.test/",
            label: "my-agent",
            fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ token: "tok-1", workspace: { workspaceId: "ws-1" } }); },
        });
        assert.equal(calls[0].url, "http://pullboard.test/api/accounts/anon-provision", "normalizes the trailing slash");
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.headers.authorization, undefined, "onboarding needs no bearer token");
        assert.deepEqual(JSON.parse(calls[0].init.body), { label: "my-agent" });
        assert.deepEqual({ token, workspaceId }, { token: "tok-1", workspaceId: "ws-1" });
    });

    test("throws stable error metadata when provisioning is refused", async () => {
        await assert.rejects(
            anonProvision({ baseUrl: "http://pullboard.test", fetchImpl: async () => response({ error: "RATE_LIMITED", message: "slow down" }, 429) }),
            (error) => error.code === "RATE_LIMITED" && error.status === 429 && error.message === "slow down",
        );
    });
});
