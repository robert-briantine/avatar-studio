// Compare sampling profiles against an immutable, completed 60s+ render.
// node --import tsx scripts/test-wan-identity.ts BASELINE OUTPUT [cfg|official] [--prepare]
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComfyClient } from "../src/comfy.js";
import { config } from "../src/config.js";
import { probeDuration, assembleWanVideo, probeVideoFrameCount } from "../src/media.js";
import type { PromptGraph } from "../src/workflows.js";

const exec = promisify(execFile);
const baselineDirectory = path.resolve(process.argv[2]);
const outputDir = path.resolve(process.argv[3]);
const profile = process.argv[4] || "cfg";
assert.ok(["cfg", "official"].includes(profile));
assert.notEqual(outputDir, baselineDirectory);
const baseline = JSON.parse(await fs.readFile(path.join(baselineDirectory, "report.json"), "utf8"));
assert.equal(baseline.status, "completed");
assert.ok(baseline.durationSeconds >= 60);
await fs.mkdir(outputDir, { recursive: true });
await fs.cp(baselineDirectory, path.join(outputDir, "baseline"), { recursive: true });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = await fs.readFile(path.join(baselineDirectory, "original-image.png"));
const audio = await fs.readFile(path.join(baselineDirectory, "original-audio.wav"));
assert.equal(hash(image), baseline.sourceImageSha256);
assert.equal(hash(audio), baseline.sourceAudioSha256);
await fs.writeFile(path.join(outputDir, "original-image.png"), image);
const audioSnapshot = path.join(outputDir, "original-audio.wav");
await fs.writeFile(audioSnapshot, audio);
assert.equal(await probeDuration(audioSnapshot), baseline.durationSeconds);
const originalGraph: PromptGraph = JSON.parse(await fs.readFile(path.join(baselineDirectory, "workflow.json"), "utf8"));
const graph = structuredClone(originalGraph);
for (const node of Object.values(graph)) {
  if (node.class_type === "KSampler") {
    node.inputs.cfg = 4.5;
    if (profile === "official") node.inputs.steps = 40;
  }
  if (profile === "official" && node.class_type === "ModelSamplingSD3") node.inputs.shift = 3;
}
// Validate every changed input before adding temporary filenames.
const changes: { node: string; input: string; before: unknown; after: unknown }[] = [];
for (const [id, node] of Object.entries(graph)) {
  for (const [input, after] of Object.entries(node.inputs)) {
    const before = originalGraph[id].inputs[input];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      assert.ok((node.class_type === "KSampler" && ["cfg", "steps"].includes(input))
        || (profile === "official" && node.class_type === "ModelSamplingSD3" && input === "shift"));
      changes.push({ node: id, input, before, after });
    }
  }
}
assert.ok(changes.length > 0);
const imageName = `wan-identity-${randomUUID()}.png`;
const audioName = `wan-identity-${randomUUID()}.wav`;
graph["7"].inputs.image = imageName;
graph["5"].inputs.audio = audioName;
Object.values(graph).find(n => n.class_type === "SaveVideo")!.inputs.filename_prefix = `dgx-avatar/${path.basename(outputDir)}`;
const report: Record<string, any> = {
  status: "prepared", experiment: `identity-sampling-${profile}`, baselineDirectory,
  project: baseline.project, durationSeconds: baseline.durationSeconds,
  sourceImageSha256: hash(image), sourceAudioSha256: hash(audio),
  sourceAudioSnapshot: audioSnapshot, sourceImageSnapshot: path.join(outputDir, "original-image.png"),
  settings: { ...baseline.settings, imageName, audioName, cfg: 4.5, ...(profile === "official" ? { steps: 40, shift: 3 } : { shift: 8 }) },
  models: baseline.models, chunks: baseline.chunks, generatedFrames: baseline.generatedFrames,
  changes, productionActivated: false, visualValidation: "awaiting-user-review",
  splitAudio: false, independentResets: 0,
  samplingProfileCaveat: "ComfyUI UniPC/simple conservé : ce test ne reproduit pas exactement le scheduler Wan officiel.",
  references: ["https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_s2v_14B.py", "https://github.com/Wan-Video/Wan2.2/blob/main/wan/speech2video.py"],
  startedAt: new Date().toISOString()
};
const save = () => fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(outputDir, "workflow.json"), JSON.stringify(graph, null, 2));
await save();
console.log(`TEST_OUTPUT=${outputDir} PROFILE=${profile}`);
if (!process.argv.includes("--prepare")) {
  const comfy = new ComfyClient();
  let tracked: Awaited<ReturnType<ComfyClient["queueTracked"]>> | undefined;
  let uploadedAudio: string | undefined;
  let uploadedImage: string | undefined;
  let progressWrites = Promise.resolve();
  const started = Date.now();
  try {
    const queue = await (await fetch(`${config.comfyUrl}/queue`)).json() as any;
    assert.equal(queue.queue_running.length + queue.queue_pending.length, 0, "ComfyUI est occupé");
    const nodes = await comfy.hasNodes([...new Set(Object.values(graph).map(n => n.class_type))]);
    assert.ok(nodes.ok, `Nœuds absents : ${nodes.missing.join(", ")}`);
    assert.ok(process.env.COMFY_INPUT_DIR);
    uploadedImage = await comfy.uploadImage(image, imageName);
    graph["7"].inputs.image = uploadedImage;
    uploadedAudio = path.join(process.env.COMFY_INPUT_DIR!, audioName);
    await fs.writeFile(uploadedAudio, audio);
    assert.equal(hash(await fs.readFile(uploadedAudio)), report.sourceAudioSha256);
    await fs.writeFile(path.join(outputDir, "workflow.json"), JSON.stringify(graph, null, 2));
    const samplers = Object.entries(graph).filter(([, n]) => n.class_type === "KSampler").map(([id]) => id);
    let currentNode = "";
    tracked = await comfy.queueTracked(graph, event => {
      if (event.type === "executing" && event.node) currentNode = event.node;
      if (event.type === "progress") {
        const progress = { sampler: samplers.indexOf(event.node || currentNode) + 1, total: samplers.length,
          value: event.value, max: event.max, updatedAt: new Date().toISOString() };
        console.log(JSON.stringify(progress));
        progressWrites = progressWrites.then(() => fs.writeFile(path.join(outputDir, "progress.json"), JSON.stringify(progress)));
      }
    });
    report.promptId = tracked.promptId;
    report.status = "running";
    await save();
    const ref = await comfy.waitForFile(tracked.promptId, [".mp4"], 0);
    const raw = path.join(outputDir, "native-raw.mp4");
    await fs.writeFile(raw, await comfy.downloadFile(ref));
    assert.equal(await probeVideoFrameCount(raw), report.generatedFrames);
    report.output = path.join(outputDir, "robot-extend-67s.mp4");
    await assembleWanVideo(raw, audioSnapshot, report.output, report.durationSeconds);
    report.status = "completed";
    report.elapsedSeconds = (Date.now() - started) / 1000;
    await progressWrites;
    await save();
    await exec(process.execPath, ["--import", "tsx", "scripts/verify-wan-extend.ts", outputDir], { maxBuffer: 1024 * 1024 });
    console.log("Rendu terminé et conservation des pixels/audio vérifiée.");
  } catch (error) {
    report.status = "error";
    report.error = String(error);
    await save();
    throw error;
  } finally {
    tracked?.close();
    if (uploadedAudio) await fs.rm(uploadedAudio, { force: true });
    if (uploadedImage) await fs.rm(path.join(process.env.COMFY_INPUT_DIR!, uploadedImage), { force: true });
  }
}
