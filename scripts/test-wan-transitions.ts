// Real GPU smoke test, using the same renderer as /api/video/generate.
// Usage: node --import tsx scripts/test-wan-transitions.ts /path/to/project
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ComfyClient } from "../src/comfy.js";
import { concatWavs, createSilence, extractAudioSegment, probeDuration, probeVideoFrameCount } from "../src/media.js";
import { renderWanSegments } from "../src/wanSegments.js";

const projectDir = process.argv[2];
const reuseDirectory = process.argv[3];
if (!projectDir) throw new Error("Indique le dossier du projet utilisé pour le test.");
const project = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
const voice = project.generations.find((generation: any) => generation.voice?.segments?.length >= 2)?.voice;
if (!voice || !project.avatar) throw new Error("Le test demande une image et deux morceaux audio existants.");
const comfy = new ComfyClient();
const queue = await (await fetch("http://127.0.0.1:8188/queue")).json() as any;
if (queue.queue_running.length || queue.queue_pending.length) throw new Error("ComfyUI est déjà occupé : le test attend une file vide.");
const inputDir = process.env.COMFY_INPUT_DIR;
if (!inputDir) throw new Error("COMFY_INPUT_DIR absent.");
await fs.mkdir("test-output", { recursive: true });
const outputDir = await fs.mkdtemp(path.resolve("test-output/wan-transitions-"));
console.log(`TEST_OUTPUT=${outputDir}`);
const silence = path.join(outputDir, "pause.wav");
await createSilence(silence, 1.2);
const segments = [];
for (let index = 0; index < 2; index++) {
  const speech = path.join(outputDir, `speech-${index + 1}.wav`);
  const audio = path.join(outputDir, `audio-${index + 1}.wav`);
  await extractAudioSegment(path.resolve(projectDir, voice.segments[index].path), speech, 0, 1.5);
  const speechDuration = await probeDuration(speech);
  const duration = await concatWavs([speech, silence], audio);
  segments.push({ path: audio, duration, speechDuration, tailSilenceSeconds: 1.2 });
}
const master = path.join(outputDir, "master.wav");
await concatWavs(segments.map(segment => segment.path), master);
const referenceImageName = await comfy.uploadImage(await fs.readFile(path.resolve(projectDir, project.avatar.path)), `wan-test-reference-${randomUUID()}.png`);
let renders = 0;
const report = await renderWanSegments({
  segments, referenceImageName, audioPath: master, outputPath: path.join(outputDir, "test-deux-morceaux.mp4"),
  workDir: outputDir, prompt: "The same person speaks naturally with a steady camera. Preserve the face, skin texture, original lighting, clothing and background.",
  strictIdentity: true, seed: 123456, width: 512, height: 288, steps: 12, cfg: 5.5,
  filenamePrefix: `dgx-avatar/test-transitions-${path.basename(outputDir)}`,
  uploadAudio: async (localPath, index) => {
    const name = `wan-test-audio-${index + 1}-${randomUUID()}.wav`;
    await fs.copyFile(localPath, path.join(inputDir, name));
    return name;
  },
  uploadImage: async localPath => comfy.uploadImage(await fs.readFile(localPath), `wan-test-frame-${randomUUID()}.png`),
  render: async (graph, outputPath) => {
    await fs.writeFile(`${outputPath}.json`, JSON.stringify(graph, null, 2));
    renders++;
    if (reuseDirectory) {
      const previous = path.join(reuseDirectory, path.basename(outputPath));
      await fs.copyFile(previous, outputPath);
      console.log(`Reprise du rendu GPU conservé : ${previous}`);
      return;
    }
    const tracked = await comfy.queueTracked(graph, event => {
      if (event.type === "progress" && event.max) console.log(`GPU ${path.basename(outputPath)} ${event.value}/${event.max}`);
    });
    console.log(`PROMPT ${tracked.promptId} ${path.basename(outputPath)}`);
    try {
      const ref = await comfy.waitForFile(tracked.promptId, [".mp4"], 0);
      await fs.writeFile(outputPath, await comfy.downloadFile(ref));
    } finally { tracked.close(); }
  },
  onProgress: async event => { console.log(event.message); }
});
const actualFrames = await probeVideoFrameCount(report.outputPath);
const expectedFrames = report.plan.reduce((sum, block) => sum + block.frames, 0);
if (renders !== segments.length || actualFrames !== expectedFrames) throw new Error(`Résultat incorrect : ${renders} rendus, ${actualFrames}/${expectedFrames} images.`);
console.log(JSON.stringify({ output: report.outputPath, renders, actualFrames, expectedFrames, duration: report.duration, transitions: report.transitions }, null, 2));
