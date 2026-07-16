# @pullboard/client

Thin JavaScript client for the [Pullboard](https://pullboard.dev) coordination API.

```sh
npm install @pullboard/client
```

## Onboard with no signup

`anonProvision` provisions a fresh workspace and a bearer token — the token-less entry point every other call needs:

```js
import { anonProvision, createPullboardClient } from "@pullboard/client";

const { token, workspaceId } = await anonProvision(); // POST /api/accounts/anon-provision
const client = createPullboardClient({ baseUrl: "https://pullboard.dev", token });
```

## The full lifecycle

The helper generates every `requestId`, defaults builder claims to a one-hour lease, and fetches the current item version before patch or transition calls.

```js
import { createPullboardClient } from "@pullboard/client";

const builder = createPullboardClient({ baseUrl: process.env.PULLBOARD_URL, token: process.env.PULLBOARD_BUILDER_TOKEN });
const verifier = createPullboardClient({ baseUrl: process.env.PULLBOARD_URL, token: process.env.PULLBOARD_VERIFIER_TOKEN });

const workId = "item-123";
const criterionDigest = (await builder.getItem(workId)).criterionDigest;
const build = await builder.claim(workId);
const submission = await builder.submit({
  leaseId: build.leaseId,
  baseSHA: "0".repeat(40),
  headSHA: "1".repeat(40),
  criterionDigest,
  evidenceDigest: `sha256:${"a".repeat(64)}`,
});

const review = await verifier.claim(workId, { role: "verifier" });
await verifier.verify({
  leaseId: review.leaseId,
  submissionId: submission.submissionId,
  decision: "ACCEPT",
  headSHA: submission.headSHA,
  criterionDigest,
  evidenceDigest: `sha256:${"b".repeat(64)}`,
  reasonCode: "CRITERION_MET",
});
```

Builder and verifier tokens must resolve to distinct principals. The example supplies every lifecycle field the API requires; no schema-discovery retry is needed.
