// Step 2 retains step 1 and changes only the seed per Extend pass.
// Usage: node --import tsx scripts/test-wan-seed-progression.ts /path/to/project /path/to/step-1
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComfyClient } from "../src/comfy.js";
import { config } from "../src/config.js";
import { buildWanS2VReencodedMotionWorkflow, WAN_S2V_MODELS } from "../src/wanS2V.js";
import { assembleWanVideo, probeDuration, probeVideoFrameCount } from "../src/media.js";
import sharp from "sharp";

const exec = promisify(execFile);
const projectDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Indique le dossier du projet à tester.");
const project = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
if (!process.argv[3]) throw new Error("Indique le dossier du rendu refusé pour conserver exactement ses réglages.");
const baselineDirectory = path.resolve(process.argv[3]);
const baseline = JSON.parse(await fs.readFile(path.join(baselineDirectory, "report.json"), "utf8"));
const voice = project.voice;
if (!voice || !project.avatar) throw new Error("Le projet doit avoir un avatar et un WAV complet.");
const comfy = new ComfyClient();
const nodeCheck = await comfy.hasNodes(["VAEEncode", "VAEDecode", "ImageFromBatch", "LatentCut", "LatentConcat", "WanSoundImageToVideoExtend"]);
if (!nodeCheck.ok) throw new Error(`Nœuds absents : ${nodeCheck.missing.join(", ")}`);
const queue = await (await fetch(`${config.comfyUrl}/queue`)).json() as any;
if (queue.queue_running.length || queue.queue_pending.length) throw new Error("ComfyUI est occupé.");
const inputDir = process.env.COMFY_INPUT_DIR;
if (!inputDir) throw new Error("COMFY_INPUT_DIR absent.");
const audioPath = path.resolve(projectDir, voice.path);
const durationSeconds = await probeDuration(audioPath);
if (durationSeconds < 60) throw new Error("Le test de dérive demande au moins 60 secondes de son.");
const outputDir = path.resolve(`test-output/wan-context-step2-seeds-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(outputDir, { recursive: true });
console.log(`TEST_OUTPUT=${outputDir}`);
const sourceImage = path.resolve(projectDir, project.avatar.path);
const imageStat = await fs.stat(sourceImage);
if (imageStat.mtimeMs > Date.parse(baseline.startedAt)) throw new Error("L’avatar a changé depuis le rendu de référence.");
const imageHash = createHash("sha256").update(await fs.readFile(sourceImage)).digest("hex");
const imageName = await comfy.uploadImage(await fs.readFile(sourceImage), `wan-extend-test-${randomUUID()}.png`);
const audioName = `wan-extend-test-${randomUUID()}.wav`;
const uploadedAudio = path.join(inputDir, audioName);
await fs.copyFile(audioPath, uploadedAudio);
const sourceHash = createHash("sha256").update(await fs.readFile(audioPath)).digest("hex");
if (sourceHash !== createHash("sha256").update(await fs.readFile(uploadedAudio)).digest("hex")) throw new Error("Le WAV a été modifié.");
if (sourceHash !== baseline.sourceAudioSha256) throw new Error("Le WAV diffère du test précédent.");
if (durationSeconds !== baseline.durationSeconds) throw new Error("La durée du WAV a changé.");
const immutableAudioPath = path.join(outputDir, "original-audio.wav");
const immutableImagePath = path.join(outputDir, "original-image.png");
await fs.copyFile(uploadedAudio, immutableAudioPath);
await fs.copyFile(path.join(inputDir, imageName), immutableImagePath);
const settings = { ...baseline.settings, imageName, audioName, durationSeconds,
  filenamePrefix: `dgx-avatar/test-context-${path.basename(outputDir)}` };
const { graph, chunks, generatedFrames } = buildWanS2VReencodedMotionWorkflow(settings);
const samplerIds = Object.entries(graph).filter(([, node]) => node.class_type === "KSampler").map(([id]) => id);
for (const [passIndex, id] of samplerIds.entries()) graph[id].inputs.seed = settings.seed + passIndex;
if (graph["1"].inputs.unet_name !== baseline.models.diffusion) throw new Error("Le modèle diffère du rendu précédent.");
const baselineGraph = JSON.parse(await fs.readFile(path.join(baselineDirectory, "workflow.json"), "utf8"));
const expectedGraph = structuredClone(baselineGraph) as Record<string, any>;
expectedGraph["5"].inputs.audio = audioName;
expectedGraph["7"].inputs.image = imageName;
for (const [passIndex, id] of samplerIds.entries()) expectedGraph[id].inputs.seed = settings.seed + passIndex;
const saveNode = Object.values(expectedGraph).find((node: any) => node.class_type === "SaveVideo") as any;
saveNode.inputs.filename_prefix = settings.filenamePrefix;
if (JSON.stringify(graph) !== JSON.stringify(expectedGraph)) {
  throw new Error("Le graphe diffère de l’étape 1 ailleurs que par les graines et noms temporaires des fichiers.");
}
const nodes = Object.values(graph);
if (nodes.filter(n => n.class_type === "WanSoundImageToVideo").length !== 1
    || nodes.filter(n => n.class_type === "WanSoundImageToVideoExtend").length !== chunks - 1
    || nodes.some(n => ["TrimAudioDuration", "DGXPrepareWanHandoff"].includes(n.class_type))) throw new Error("Workflow non natif.");
await fs.writeFile(path.join(outputDir, "workflow.json"), JSON.stringify(graph, null, 2));
const started = Date.now();
const manifest: Record<string, any> = { status: "running", project: project.name, sourceAudio: audioPath,
  sourceAudioSha256: sourceHash, sourceAudioSnapshot: immutableAudioPath,
  sourceImage, sourceImageSha256: imageHash, sourceImageSnapshot: immutableImagePath,
  experiment: "step-2-seed-progression-after-step-1", baselineDirectory,
  productionActivated: false, changedParameter: "per-pass-seed",
  previousStepChangeRetained: "motion-context-vae-roundtrip",
  seedPolicy: "seed-plus-sampler-index",
  durationSeconds, chunks, generatedFrames, settings, models: WAN_S2V_MODELS,
  splitAudio: false, independentResets: 0, motionReencodings: chunks - 1, visualValidation: "awaiting-user-review", postProcessing: "trim-end-and-mux-original-audio", startedAt: new Date().toISOString() };
const saveReport = () => fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(manifest, null, 2));
await saveReport();
console.log(`ÉTAPE 2 : contexte visuel de l’étape 1 conservé ; WAV complet ${durationSeconds}s, ${chunks} passes, BF16, 20 étapes, CFG 6, shift 8, graines ${settings.seed}–${settings.seed + chunks - 1}, 384x512.`);
let currentNode = "";
let progressWrites = Promise.resolve();
const tracked = await comfy.queueTracked(graph, event => {
  if (event.type === "executing" && event.node) {
    currentNode = event.node;
    console.log(`${new Date().toISOString()} NODE ${event.node} ${graph[event.node]?.class_type}`);
  }
  if (event.type === "progress" && event.max && event.value !== undefined) {
    const samplerIndex = samplerIds.indexOf(event.node || currentNode);
    console.log(`${new Date().toISOString()} GPU ${event.node || currentNode} ${samplerIndex >= 0 ? `PASS ${samplerIndex + 1}/${chunks}` : "VAE"} ${event.value}/${event.max}`);
    const state = { currentNode: event.node || currentNode, sampler: samplerIndex + 1,
      value: event.value, max: event.max, updatedAt: new Date().toISOString() };
    progressWrites = progressWrites.then(() => fs.writeFile(path.join(outputDir, "progress.json"), JSON.stringify(state, null, 2)));
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
  await assembleWanVideo(raw, immutableAudioPath, output, durationSeconds);
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
  await progressWrites;
  const label = times.map(time => `<figure><img src="frame-${String(time).padStart(2, "0")}s.png"><figcaption>${time} s</figcaption></figure>`).join("");
  await fs.writeFile(path.join(outputDir, "validation.html"), `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Étape 2 · vidéo à valider</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;background:#14191f;color:#eee;padding:0 20px}video{width:100%;height:65vh;background:#090d11}button{font:inherit;padding:10px;margin:8px;cursor:pointer}.captures{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}figure{margin:0}img{width:100%}a{color:#b9d8ff}</style><h1>Étape 2 : vidéo à valider</h1><p>Même robot et son complet de 67 secondes. Le contexte visuel de l’étape 1 est conservé ; seule la graine change à chaque extension.</p><video id="v" controls preload="metadata" src="robot-extend-67s.mp4"></video><div><button data-t="0">Début</button><button data-t="45">À partir de 45 s</button><button data-t="60">À partir de 60 s</button></div><p>Regarde surtout la fin de la vidéo, puis indique dans la conversation si la dégradation reste gênante. La prochaine étape attend ton avis.</p><p><a href="robot-extend-67s.mp4" download>Télécharger la vidéo</a> · <a href="http://127.0.0.1:3032/validation.html" target="_blank" rel="noopener">Voir le rendu de l’étape 1</a></p><div class="captures">${label}</div><script>document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{const v=document.getElementById('v');v.currentTime=Number(b.dataset.t);v.play()})</script></html>`);
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
