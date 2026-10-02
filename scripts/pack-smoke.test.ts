import { strict as assert } from "node:assert";
import { test } from "node:test";
import { smokeFailures } from "./pack-smoke.ts";

test("browser-only and subpath import failures fail smoke even when every package passed", () => {
  const results = new Map([["@platform-kits/overlay", "pass"], ["@platform-kits/browser", "pass"]]);
  assert.deepEqual(smokeFailures(results), []);
  results.set("@platform-kits/overlay [browser]", "FAIL: browser import failed");
  results.set("@platform-kits/browser/testing", "FAIL: default import failed");
  assert.deepEqual(smokeFailures(results), ["@platform-kits/overlay [browser]", "@platform-kits/browser/testing"]);
});
