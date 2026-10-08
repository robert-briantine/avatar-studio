// Full-audio GPU regression test; intentionally keeps renders outside user history.
// Usage: node --import tsx scripts/test-wan-extend.ts /path/to/project [generationId]
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComfyClient } from "../src/comfy.js";
import { config } from "../src/config.js";
import { buildWanS2VExtendedWorkflow, wanS2VPrompt, WAN_S2V_MODELS } from "../src/wanS2V.js";
import { assembleWanVideo, probeDuration, probeVideoFrameCount } from "../src/media.js";
import sharp from "sharp";

const exec = promisify(execFile);
const projectDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Indique le dossier du projet à tester.");
const project = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
const generation = process.argv[3] ? project.generations.find((item: any) => item.id === process.argv[3]) : undefined;
const voice = generation?.voice || project.voice;
if (!voice || !project.avatar) throw new Error("Le projet doit avoir un avatar et un WAV complet.");
const comfy = new ComfyClient();
const queue = await (await fetch(`${config.comfyUrl}/queue`)).json() as any;
if (queue.queue_running.length || queue.queue_pending.length) throw new Error("ComfyUI est occupé.");
const inputDir = process.env.COMFY_INPUT_DIR;
if (!inputDir) throw new Error("COMFY_INPUT_DIR absent.");
const audioPath = path.resolve(projectDir, voice.path);
const durationSeconds = await probeDuration(audioPath);
if (durationSeconds < 60) throw new Error("Le test de dérive demande au moins 60 secondes de son.");
const outputDir = path.resolve(`test-output/wan-extend-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(outputDir, { recursive: true });
console.log(`TEST_OUTPUT=${outputDir}`);
const sourceImage = path.resolve(projectDir, project.avatar.path);
const imageName = await comfy.uploadImage(await fs.readFile(sourceImage), `wan-extend-test-${randomUUID()}.png`);
const audioName = `wan-extend-test-${randomUUID()}.wav`;
const uploadedAudio = path.join(inputDir, audioName);
await fs.copyFile(audioPath, uploadedAudio);
const sourceHash = createHash("sha256").update(await fs.readFile(audioPath)).digest("hex");
if (sourceHash !== createHash("sha256").update(await fs.readFile(uploadedAudio)).digest("hex")) throw new Error("Le WAV a été modifié.");
const settings = { imageName, audioName, durationSeconds, prompt: wanS2VPrompt(true), strictIdentity: true,
  seed: 123456, width: 384, height: 512, steps: 20, cfg: 6,
  filenamePrefix: `dgx-avatar/test-extend-${path.basename(outputDir)}` };
const { graph, chunks, generatedFrames } = buildWanS2VExtendedWorkflow(settings);
const nodes = Object.values(graph);
if (nodes.filter(n => n.class_type === "WanSoundImageToVideo").length !== 1
    || nodes.filter(n => n.class_type === "WanSoundImageToVideoExtend").length !== chunks - 1
    || nodes.some(n => ["TrimAudioDuration", "DGXPrepareWanHandoff"].includes(n.class_type))) throw new Error("Workflow non natif.");
await fs.writeFile(path.join(outputDir, "workflow.json"), JSON.stringify(graph, null, 2));
const started = Date.now();
const manifest: Record<string, any> = { status: "running", project: project.name, sourceAudio: audioPath,
  sourceAudioSha256: sourceHash, durationSeconds, chunks, generatedFrames, settings, models: WAN_S2V_MODELS,
  splitAudio: false, independentResets: 0, postProcessing: "trim-end-and-mux-original-audio", startedAt: new Date().toISOString() };
const saveReport = () => fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(manifest, null, 2));
await saveReport();
console.log(`WAV complet ${durationSeconds}s, ${chunks} passes, BF16, 20 étapes, 384x512.`);
let currentNode = "";
const tracked = await comfy.queueTracked(graph, event => {
  if (event.type === "executing" && event.node) {
    currentNode = event.node;
    console.log(`${new Date().toISOString()} NODE ${event.node} ${graph[event.node]?.class_type}`);
  }
  if (event.type === "progress" && event.max && event.value !== undefined) {
    console.log(`${new Date().toISOString()} GPU ${event.node || currentNode} ${event.value}/${event.max}`);
  }
});
manifest.promptId = tracked.promptId;
await saveReport();
console.log(`PROMPT_ID=${tracked.promptId}`);
try {
  const ref = await comfy.waitForFile(tracked.promptId, [".mp4"], 0);
  manifest.comfyOutput = ref;
  const raw = path.join(outputDir, "native-raw.mp4");
  await fs.writeFile(raw, await comfy.downloadFile(ref));
  const output = path.join(outputDir, "robot-extend-67s.mp4");
  await assembleWanVideo(raw, audioPath, output, durationSeconds);
  manifest.output = output;
  manifest.actualDuration = await probeDuration(output);
  manifest.actualFrames = await probeVideoFrameCount(output);
  manifest.rawFrames = await probeVideoFrameCount(raw);
  if (manifest.rawFrames !== generatedFrames) throw new Error(`VAE : ${manifest.rawFrames} images réelles / ${generatedFrames} attendues.`);
  if (Math.abs(manifest.actualDuration - durationSeconds) > 1 / 16) throw new Error("Durée du rendu incorrecte.");
  const times = [0, 10, 30, 45, 50, 60, Math.floor(durationSeconds - 1)];
  const paths: string[] = [];
  for (const time of times) {
    const capture = path.join(outputDir, `frame-${String(time).padStart(2, "0")}s.png`);
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(time), "-i", output, "-frames:v", "1", capture]);
    paths.push(capture);
  }
  const thumbnails = await Promise.all(paths.map(async (file, index) => {
    const thumbnail = await sharp(file).resize(192, 256).extend({ bottom: 28, background: "#ffffff" }).png().toBuffer();
    const label = Buffer.from(`<svg width="192" height="284"><text x="8" y="275" font-size="18" font-family="sans-serif">${times[index]} s</text></svg>`);
    return sharp(thumbnail).composite([{ input: label }]).png().toBuffer();
  }));
  await sharp({ create: { width: 192 * thumbnails.length, height: 284, channels: 3, background: "#fff" } })
    .composite(thumbnails.map((input, index) => ({ input, left: index * 192, top: 0 }))).png().toFile(path.join(outputDir, "contact-sheet.png"));
  manifest.status = "completed";
  manifest.elapsedSeconds = (Date.now() - started) / 1000;
  await saveReport();
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  manifest.status = "error";
  manifest.error = String(error);
  await saveReport();
  throw error;
} finally {
  tracked.close();
  await fs.rm(uploadedAudio, { force: true });
  await fs.rm(path.join(inputDir, imageName), { force: true });
}
