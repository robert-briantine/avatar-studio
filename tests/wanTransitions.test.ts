import assert from "node:assert/strict";
import test from "node:test";
import { parseWanTransitionStyle } from "../src/wanTransitions.js";

test("transition choices default to 3 and only accept the two approved treatments", () => {
  assert.equal(parseWanTransitionStyle(), "interpolated");
  assert.equal(parseWanTransitionStyle("interpolated"), "interpolated");
  assert.equal(parseWanTransitionStyle("reconstructed"), "reconstructed");
  for (const value of [null, "", "unknown", "3", 4, {}, false]) {
    assert.throws(() => parseWanTransitionStyle(value), /Mouvement interpolé.*Reprise reconstruite/);
  }
});
