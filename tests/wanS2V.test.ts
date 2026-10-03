import assert from "node:assert/strict";
import test from "node:test";
import { buildWanS2VExtendedWorkflow, buildWanS2VStabilizedWorkflow, planWanS2VWindows, parseWanStabilizationSeconds, WAN_S2V_NODES, WAN_S2V_STABLE_NODES } from "../src/wanS2V.js";
import type { PromptGraph } from "../src/workflows.js";

const input = {
  imageName: "reference.png", audioName: "speech.wav", prompt: "",
  strictIdentity: true, seed: 123456
};

// Follow the latent all the way to the decoder. Temporal extensions must never
// multiply the number of independent videos, even for a long narration.
function latentShape(graph: PromptGraph, id: string): { batch: number; blocks: number } {
  const node = graph[id];
  const linked = (name: string) => latentShape(graph, (node.inputs[name] as [string, number])[0]);
  switch (node.class_type) {
    case "WanSoundImageToVideo": return { batch: Number(node.inputs.batch_size), blocks: 1 };
    case "WanSoundImageToVideoExtend": return { batch: linked("video_latent").batch, blocks: 1 };
    case "KSampler": return linked("latent_image");
    case "LatentConcat": {
      assert.equal(node.inputs.dim, "t");
      const a = linked("samples1"), b = linked("samples2");
      assert.equal(a.batch, b.batch);
      return { batch: a.batch, blocks: a.blocks + b.blocks };
    }
    default: throw new Error(`Unexpected latent node: ${node.class_type}`);
  }
}

function assertAcyclic(graph: PromptGraph): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    assert.ok(graph[id], `Missing node ${id}`);
    assert.ok(!active.has(id), `Cyclic dependency at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const value of Object.values(graph[id].inputs)) {
      if (Array.isArray(value)) visit(String(value[0]));
    }
    active.delete(id);
    visited.add(id);
  };
  Object.keys(graph).forEach(visit);
}

for (const [durationSeconds, expectedBlocks] of [[1, 1], [77 / 16, 1], [78 / 16, 2], [10, 3], [60, 13]]) {
  test(`one output video covering ${durationSeconds}s of audio`, () => {
    const { graph, chunks, generatedFrames } = buildWanS2VExtendedWorkflow({ ...input, durationSeconds });
    const nodes = Object.values(graph);
    assert.equal(chunks, expectedBlocks);
    assert.ok(generatedFrames >= Math.ceil(durationSeconds * 16));
    assert.ok(generatedFrames - Math.ceil(durationSeconds * 16) < 77);
    const decoders = nodes.filter(node => node.class_type === "VAEDecode");
    assert.equal(decoders.length, 1);
    const latentId = (decoders[0].inputs.samples as [string, number])[0];
    assert.deepEqual(latentShape(graph, latentId), { batch: 1, blocks: expectedBlocks });
    assert.equal(nodes.filter(node => node.class_type === "AudioEncoderEncode").length, 1);
    assert.equal(nodes.filter(node => node.class_type === "SaveVideo").length, 1);
    const video = nodes.find(node => node.class_type === "CreateVideo")!;
    const audioId = (video.inputs.audio as [string, number])[0];
    assert.equal(graph[audioId].inputs.audio, "speech.wav");
    assert.equal(video.inputs.fps, 16);
    for (const node of nodes) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing input node ${value[0]}`);
      }
      if (node.class_type === "KSampler") {
        assert.equal(node.inputs.steps, 20);
        assert.equal(node.inputs.cfg, 6);
        assert.equal(node.inputs.seed, input.seed);
        assert.equal(node.inputs.sampler_name, "uni_pc");
      }
      if (node.class_type === "WanSoundImageToVideo") {
        assert.equal(node.inputs.width, 768);
        assert.equal(node.inputs.height, 432);
      }
    }
  });
}

test("explicit quality and identity settings survive every extension", () => {
  const { graph } = buildWanS2VExtendedWorkflow({
    ...input, durationSeconds: 12, steps: 28, cfg: 5.5,
    width: 832, height: 480, filenamePrefix: "test/custom"
  });
  for (const node of Object.values(graph)) {
    if (node.class_type === "KSampler") {
      assert.equal(node.inputs.steps, 28);
      assert.equal(node.inputs.cfg, 5.5);
      const conditioning = graph[(node.inputs.positive as [string, number])[0]];
      const text = graph[(conditioning.inputs.positive as [string, number])[0]];
      assert.equal(text.inputs.text, "");
      const reference = graph[(conditioning.inputs.ref_image as [string, number])[0]];
      assert.equal(reference.inputs.image, input.imageName);
      const negative = graph[(conditioning.inputs.negative as [string, number])[0]];
      assert.match(String(negative.inputs.text), /identity change/);
    }
    if (node.class_type === "SaveVideo") assert.equal(node.inputs.filename_prefix, "test/custom");
  }
});

test("stabilization preserves the existing workflow for short videos", () => {
  for (const durationSeconds of [1, 6, 20, 20.5]) {
    const args = { ...input, durationSeconds };
    assert.deepEqual(buildWanS2VStabilizedWorkflow(args), buildWanS2VExtendedWorkflow(args));
  }
});

for (const durationSeconds of [329 / 16, 648 / 16, 649 / 16, 24, 53.657, 60, 60.013, 122.18]) {
  test(`stabilization bounds drift and preserves the audio timeline for ${durationSeconds}s`, () => {
    const { graph, chunks, windows } = buildWanS2VStabilizedWorkflow({ ...input, durationSeconds });
    const nodes = Object.values(graph);
    const requestedFrames = Math.ceil(durationSeconds * 16);
    const crops = nodes.filter(node => node.class_type === "ImageFromBatch"
      && graph[(node.inputs.image as [string, number])[0]].class_type === "VAEDecode");
    const trims = nodes.filter(node => node.class_type === "TrimAudioDuration");
    assert.equal(crops.length, trims.length);
    assert.ok(windows && windows.length === trims.length);
    assert.equal(chunks, crops.reduce((sum, crop) => sum + Math.ceil(Number(crop.inputs.length) / 77), 0));
    assert.equal(nodes.filter(node => node.class_type === "KSampler").length, chunks);
    let elapsedFrames = 0;
    for (let i = 0; i < crops.length; i++) {
      if (i > 0) elapsedFrames -= 8;
      assert.equal(trims[i].inputs.start_index, elapsedFrames / 16);
      const frames = Number(crops[i].inputs.length);
      assert.deepEqual(windows[i], { startFrame: elapsedFrames, frames });
      assert.equal(trims[i].inputs.duration, frames / 16);
      assert.ok(frames > 0 && frames <= 328);
      const decoder = graph[(crops[i].inputs.image as [string, number])[0]];
      const latent = latentShape(graph, (decoder.inputs.samples as [string, number])[0]);
      assert.equal(latent.batch, 1);
      assert.equal(latent.blocks, Math.ceil(frames / 77));
      assert.ok(latent.blocks <= 5, "latent history must stay within the configured interval plus overlap");
      elapsedFrames += frames;
    }
    assert.equal(elapsedFrames, requestedFrames);
    // The images, not latent histories, are joined across reset boundaries.
    const video = nodes.find(node => node.class_type === "CreateVideo")!;
    const imageCount = (id: string): number => {
      const node = graph[id];
      if (node.class_type === "ImageFromBatch") return Number(node.inputs.length);
      assert.equal(node.class_type, "ImageBatch");
      return imageCount((node.inputs.image1 as [string, number])[0]) + imageCount((node.inputs.image2 as [string, number])[0]);
    };
    assert.equal(imageCount((video.inputs.images as [string, number])[0]), requestedFrames + 8 * (crops.length - 1));
    // Audio is muxed only after the duplicated overlap frames are merged.
    assert.equal(video.inputs.audio, undefined);
    for (const type of ["LoadAudio", "LoadImage", "UNETLoader", "CLIPLoader", "AudioEncoderLoader", "SaveVideo"]) {
      assert.equal(nodes.filter(node => node.class_type === type).length, 1, `${type} must stay shared`);
    }
    const encodedAudioSources = new Set(nodes.filter(node => node.class_type === "AudioEncoderEncode")
      .map(node => (node.inputs.audio as [string, number])[0]));
    assert.equal(encodedAudioSources.size, trims.length);
    for (const node of nodes) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing node ${value[0]}`);
      }
      if (node.class_type === "KSampler") {
        assert.equal(node.inputs.steps, 20);
        assert.equal(node.inputs.cfg, 6);
        const conditioning = graph[(node.inputs.positive as [string, number])[0]];
        const reference = graph[(conditioning.inputs.ref_image as [string, number])[0]];
        assert.equal(reference.inputs.image, input.imageName);
      }
    }
    assertAcyclic(graph);
  });
}

for (const chunkFrames of [77, 41]) {
  test(`pose handoff stays before the overlap and preserves the original identity (${chunkFrames} frames)`, () => {
    const { graph, windows } = buildWanS2VStabilizedWorkflow({
      ...input, durationSeconds: 60, chunkFrames, width: 832, height: 480, steps: 28, cfg: 5.5
    });
    assert.ok(windows && windows.length > 2);
    const nodes = Object.values(graph);
    const starts = nodes.filter(node => node.class_type === "WanSoundImageToVideo");
    const crops = Object.entries(graph).filter(([, node]) => node.class_type === "ImageFromBatch"
      && graph[(node.inputs.image as [string, number])[0]].class_type === "VAEDecode");
    assert.equal(starts.length, windows.length);
    assert.equal(nodes.filter(node => node.class_type === "DGXRestoreWanReference").length, windows.length - 1);
    assert.equal(nodes.filter(node => node.class_type === "ImageSharpen").length, 0);
    assert.equal(nodes.filter(node => node.class_type === "RepeatImageBatch").length, windows.length - 1);
    assert.equal(starts[0].inputs.ref_motion, undefined);
    for (let i = 1; i < starts.length; i++) {
      const motion = graph[(starts[i].inputs.ref_motion as [string, number])[0]];
      assert.equal(motion.class_type, "RepeatImageBatch");
      assert.equal(motion.inputs.amount, 73, "fill Wan's pose context without synthetic gray frames");
      const restore = graph[(motion.inputs.image as [string, number])[0]];
      assert.equal(restore.class_type, "DGXRestoreWanReference");
      const original = graph[(restore.inputs.original as [string, number])[0]];
      assert.equal(original.class_type, "LoadImage", "rebuild every handoff from the untouched original");
      assert.equal(original.inputs.image, input.imageName);
      const frame = graph[(restore.inputs.image as [string, number])[0]];
      assert.equal(frame.class_type, "ImageFromBatch");
      assert.equal(frame.inputs.length, 1);
      assert.deepEqual(frame.inputs.image, [crops[i - 1][0], 0], "read the preceding window before video compression");
      const localIndex = Number(frame.inputs.batch_index);
      assert.ok(localIndex >= 0 && localIndex < windows[i - 1].frames);
      assert.equal(windows[i - 1].startFrame + localIndex, windows[i].startFrame - 1,
        "future overlap frames must never condition an earlier audio instant");
    }
    const requiredNodes = new Set<string>([...WAN_S2V_NODES, ...WAN_S2V_STABLE_NODES]);
    for (const node of nodes) {
      assert.ok(requiredNodes.has(node.class_type), `Missing preflight check for ${node.class_type}`);
      if (node.class_type === "WanSoundImageToVideo" || node.class_type === "WanSoundImageToVideoExtend") {
        const reference = graph[(node.inputs.ref_image as [string, number])[0]];
        assert.equal(reference.class_type, "LoadImage");
        assert.equal(reference.inputs.image, input.imageName, "generated frames must never replace the identity reference");
      }
      if (node.class_type === "WanSoundImageToVideoExtend") assert.equal(node.inputs.ref_motion, undefined);
      if (node.class_type === "WanSoundImageToVideo") {
        assert.equal(node.inputs.width, 832);
        assert.equal(node.inputs.height, 480);
      }
      if (node.class_type === "KSampler") {
        assert.equal(node.inputs.steps, 28);
        assert.equal(node.inputs.cfg, 5.5);
        assert.equal(node.inputs.seed, input.seed);
      }
    }
    assertAcyclic(graph);
  });
}

test("20-second stabilization resumes at 20, 40 and 60 seconds from the preceding image", () => {
  const { graph, windows } = buildWanS2VStabilizedWorkflow({ ...input, durationSeconds: 65 });
  assert.deepEqual(windows, [
    { startFrame: 0, frames: 328 }, { startFrame: 320, frames: 328 },
    { startFrame: 640, frames: 328 }, { startFrame: 960, frames: 80 }
  ]);
  const starts = Object.values(graph).filter(node => node.class_type === "WanSoundImageToVideo");
  for (const start of starts.slice(1)) {
    const repeated = graph[(start.inputs.ref_motion as [string, number])[0]];
    const restored = graph[(repeated.inputs.image as [string, number])[0]];
    assert.equal(restored.class_type, "DGXRestoreWanReference");
    const original = graph[(restored.inputs.original as [string, number])[0]];
    assert.equal(original.class_type, "LoadImage");
    assert.equal(original.inputs.image, input.imageName);
    const lastFrame = graph[(restored.inputs.image as [string, number])[0]];
    assert.equal(lastFrame.inputs.batch_index, 319, "handoff uses the last image before 20 seconds, not a later overlap frame");
    assert.equal(lastFrame.inputs.length, 1);
  }
});

for (const stabilizationSeconds of [1, 5, 9.5, 20, 30, 120]) {
  test(`configurable ${stabilizationSeconds}s resets cover the audio exactly, including short tails`, () => {
    const intervalFrames = stabilizationSeconds * 16;
    for (const durationSeconds of [0.5, stabilizationSeconds, stabilizationSeconds + 0.5,
      stabilizationSeconds + 0.5625, 2 * stabilizationSeconds + 0.5, 3 * stabilizationSeconds + 0.013]) {
      const windows = planWanS2VWindows(durationSeconds, stabilizationSeconds);
      const end = windows.at(-1)!;
      assert.equal(end.startFrame + end.frames, Math.ceil(durationSeconds * 16));
      windows.forEach((window, i) => {
        assert.equal(window.startFrame, i * intervalFrames);
        assert.ok(window.frames > 0 && window.frames <= intervalFrames + 8);
        if (i) {
          assert.equal(windows[i - 1].startFrame + windows[i - 1].frames - window.startFrame, 8);
          assert.ok(window.frames > 8, "a final overlap-only window must never be rendered");
        }
      });
      const args = { ...input, durationSeconds, stabilizationSeconds };
      const workflow = buildWanS2VStabilizedWorkflow(args);
      if (windows.length === 1) assert.deepEqual(workflow, buildWanS2VExtendedWorkflow(args));
      else {
        assert.deepEqual(workflow.windows, windows);
        assertAcyclic(workflow.graph);
        const trims = Object.values(workflow.graph).filter(node => node.class_type === "TrimAudioDuration");
        assert.deepEqual(trims.map(node => node.inputs.start_index), windows.map(window => window.startFrame / 16));
      }
    }
  });
}

test("invalid delays are rejected and valid delays align to video frames", () => {
  assert.equal(parseWanStabilizationSeconds(), 20);
  assert.equal(parseWanStabilizationSeconds("20.5"), 20.5);
  assert.equal(parseWanStabilizationSeconds(20.1), 20.125);
  for (const invalid of [0, -1, 0.5, 120.1, NaN, Infinity, null, "", " ", "bad", true, [], {}]) {
    assert.throws(() => parseWanStabilizationSeconds(invalid), /entre 1 et 120/);
  }
  assert.throws(() => buildWanS2VStabilizedWorkflow({ ...input, durationSeconds: 60, stabilizationSeconds: 0 }), /entre 1 et 120/);
});

test("continuous rendering ignores stabilization settings", () => {
  const args = { ...input, durationSeconds: 60 };
  assert.deepEqual(buildWanS2VExtendedWorkflow({ ...args, stabilizationSeconds: 5 }), buildWanS2VExtendedWorkflow(args));
});
