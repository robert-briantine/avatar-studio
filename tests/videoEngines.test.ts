import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoEngine, videoEngineJobType, VIDEO_ENGINE_LABELS } from "../src/videoEngines.js";

test("video engines preserve Wan as the backward-compatible default", () => {
  assert.equal(parseVideoEngine(undefined), "wan-s2v");
  assert.equal(parseVideoEngine("unknown"), "wan-s2v");
  assert.equal(videoEngineJobType("wan-s2v"), "video-wan");
  assert.match(VIDEO_ENGINE_LABELS["wan-s2v"], /mode actuel/);
});

test("hybrid and LongCat have distinct persisted job types", () => {
  assert.equal(parseVideoEngine("hybrid"), "hybrid");
  assert.equal(parseVideoEngine("longcat"), "longcat");
  assert.equal(videoEngineJobType("hybrid"), "video-hybrid");
  assert.equal(videoEngineJobType("longcat"), "video-longcat");
});
