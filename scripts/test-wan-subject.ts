// Render immutable subject snapshots with the robot's fixed-framing recipe.
// node --import tsx scripts/test-wan-subject.ts OUTPUT [framing|official|face]
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComfyClient } from "../src/comfy.js";
import { config } from "../src/config.js";
import { buildWanS2VFixedFramingWorkflow, WAN_S2V_MODELS, wanS2VPrompt } from "../src/wanS2V.js";
import { assembleWanVideo, probeDuration, probeVideoFrameCount } from "../src/media.js";

const exec = promisify(execFile);
assert.ok(process.argv[2], "Indique le dossier contenant les snapshots.");
const outputDir = path.resolve(process.argv[2]);
const profile = process.argv[3] || "framing";
assert.ok(["framing", "official", "face"].includes(profile));
const sources = JSON.parse(await fs.readFile(path.join(outputDir, "sources.json"), "utf8"));
const imagePath = path.join(outputDir, "original-image.png");
const audioPath = path.join(outputDir, "original-audio.wav");
const image = await fs.readFile(imagePath);
const audio = await fs.readFile(audioPath);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const durationSeconds = await probeDuration(audioPath);
assert.ok(durationSeconds >= 60);
const imageName = `wan-subject-${randomUUID()}.png`;
const audioName = `wan-subject-${randomUUID()}.wav`;
const settings = { imageName, audioName, durationSeconds, prompt: wanS2VPrompt(true),
  strictIdentity: true, seed: 123456, width: sources.width ?? 448, height: sources.height ?? 448,
  steps: profile === "official" ? 40 : 20, cfg: profile === "official" ? 4.5 : 6,
  filenamePrefix: `dgx-avatar/${path.basename(outputDir)}` };
const { graph, chunks, generatedFrames } = buildWanS2VFixedFramingWorkflow(settings);
if (profile === "official") graph["10"].inputs.shift = 3;
if (profile === "face") {
  assert.ok(sources.faceIdentityPrompt, "Description du visage nécessaire.");
  const baselineGraph = structuredClone(graph);
  graph["8"].inputs.text += " Facial identity remains constant throughout the entire recording. Keep the reference head shape, facial proportions, eye size and spacing, nose shape, jawline and surface detail consistent from beginning to end. Small speech-driven mouth and jaw articulation, subtle blinking. Calm expression and minimal head rotation. " + sources.faceIdentityPrompt;
  const restored = structuredClone(graph);
  restored["8"].inputs.text = baselineGraph["8"].inputs.text;
  assert.deepEqual(restored, baselineGraph, "Seul le prompt positif doit changer pour la variante visage.");
}
assert.equal(graph["1"].inputs.unet_name, "wan2.2_s2v_14B_bf16.safetensors");
const report: Record<string, any> = { status: "prepared", project: sources.project, sources,
  experiment: `subject-validation-${profile}`, settings: { ...settings, prompt: graph["8"].inputs.text, shift: graph["10"].inputs.shift },
  changedParameter: profile === "face" ? "positive-face-identity-prompt-only" : "subject",
  models: WAN_S2V_MODELS, durationSeconds, chunks, generatedFrames,
  sourceAudioSnapshot: audioPath, sourceImageSnapshot: imagePath,
  sourceAudioSha256: hash(audio), sourceImageSha256: hash(image),
  productionActivated: false, splitAudio: false, independentResets: 0,
  visualValidation: "awaiting-user-review", output: path.join(outputDir, sources.renderFilename || "robert.mp4"),
  resolutionReason: "Ratio de l’image originale conservé ; aire proche de 196608 pixels.",
  recipeReference: profile !== "official" ? "wan-context-step3-framing-2026-10-07T16-39-36-855Z" : "wan-identity-official-20261008",
  startedAt: new Date().toISOString() };
const save = () => fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(outputDir, "workflow.json"), JSON.stringify(graph, null, 2));
await save();
const comfy = new ComfyClient();
let tracked: Awaited<ReturnType<ComfyClient["queueTracked"]>> | undefined;
let uploadedAudio: string | undefined;
let uploadedImage: string | undefined;
let progressWrites = Promise.resolve();
try {
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
    const sampler = samplers.indexOf(event.node || currentNode) + 1;
    if ((event.type === "executing" && sampler > 0) || event.type === "progress") {
      const progress = { sampler, total: chunks, value: event.value, max: event.max, updatedAt: new Date().toISOString() };
      console.log(JSON.stringify(progress));
      if (sampler > 0) report.status = "running";
      progressWrites = progressWrites.then(async () => {
        await fs.writeFile(path.join(outputDir, "progress.json"), JSON.stringify(progress));
        await save();
      });
    }
  });
  report.promptId = tracked.promptId;
  if (report.status !== "running") report.status = "queued";
  await save();
  console.log(`TEST_OUTPUT=${outputDir} PROMPT_ID=${tracked.promptId} PROFILE=${profile}`);
  const ref = await comfy.waitForFile(tracked.promptId, [".mp4"], 0);
  report.comfyOutput = ref;
  const raw = path.join(outputDir, "native-raw.mp4");
  await fs.writeFile(raw, await comfy.downloadFile(ref));
  assert.equal(await probeVideoFrameCount(raw), generatedFrames);
  await assembleWanVideo(raw, audioPath, report.output, durationSeconds);
  await progressWrites;
  report.status = "completed";
  report.finishedAt = new Date().toISOString();
  await save();
  await exec(process.execPath, ["--import", "tsx", "scripts/verify-wan-extend.ts", outputDir], { maxBuffer: 1024 * 1024 });
  console.log("Rendu et vérifications terminés.");
} catch (error) {
  await progressWrites;
  report.status = "error";
  report.error = String(error);
  await save();
  throw error;
} finally {
  tracked?.close();
  if (uploadedAudio) await fs.rm(uploadedAudio, { force: true });
  if (uploadedImage) await fs.rm(path.join(process.env.COMFY_INPUT_DIR!, uploadedImage), { force: true });
}
