import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createPullboardClient } from "../src/index.js";

describe("index", () => {
    test("requires both the base URL and token before issuing requests", () => {
        assert.throws(() => createPullboardClient({ baseUrl: "", token: "secret" }), {
            name: "TypeError",
            message: "baseUrl and token are required",
        });
        assert.throws(() => createPullboardClient({ baseUrl: "http://pullboard.test", token: "" }), {
            name: "TypeError",
            message: "baseUrl and token are required",
        });
    });
});
