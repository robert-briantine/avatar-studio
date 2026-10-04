import assert from "node:assert/strict";
import test from "node:test";
import { parseShortOptions, shortVideoFilter } from "../src/shortMaker.js";

test("Short options use safe YouTube defaults", () => {
  assert.deepEqual(parseShortOptions({}), {
    framing: "blur",
    upscale: false,
    aiModel: "RealESRGAN_x2plus",
    normalizeAudio: true
  });
  assert.deepEqual(parseShortOptions({
    framing: "crop", upscale: "true", aiModel: "RealESRGAN_x4plus", normalizeAudio: false
  }), {
    framing: "crop",
    upscale: true,
    aiModel: "RealESRGAN_x4plus",
    normalizeAudio: false
  });
});

test("all Short framing modes target an exact 1080 x 1920 frame", () => {
  const blur = shortVideoFilter("blur");
  assert.equal(blur.type, "complex");
  assert.match(blur.filter, /scale=1080:1920/);
  assert.match(blur.filter, /crop=1080:1920/);
  assert.equal(blur.map, "[vout]");

  const crop = shortVideoFilter("crop");
  assert.equal(crop.type, "simple");
  assert.match(crop.filter, /scale=1080:1920/);
  assert.match(crop.filter, /crop=1080:1920/);

  const fit = shortVideoFilter("fit");
  assert.equal(fit.type, "simple");
  assert.match(fit.filter, /scale=1080:1920/);
  assert.match(fit.filter, /pad=1080:1920/);
});

