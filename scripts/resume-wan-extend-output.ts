// Resume export and review-asset creation for a native Extend prompt already
// running in ComfyUI after the original monitor process was interrupted.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { ComfyClient } from "../src/comfy.js";
import { config } from "../src/config.js";
import { assembleWanVideo, probeDuration, probeVideoFrameCount } from "../src/media.js";

const exec = promisify(execFile);
const directory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Indique le dossier du test déjà lancé.");
const reportPath = path.join(directory, "report.json");
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
if (!report.promptId || !report.sourceAudioSnapshot) throw new Error("Le rapport ne permet pas de reprendre cette génération.");
if (report.status === "completed") throw new Error("L’export est déjà terminé.");

const comfy = new ComfyClient();
console.log(`REPRISE_PROMPT=${report.promptId}`);
const ref = report.comfyOutput ?? await comfy.waitForFile(report.promptId, [".mp4"], 0);
const raw = path.join(directory, "native-raw.mp4");
if (!(await fs.stat(raw).then(() => true, () => false))) {
  await fs.writeFile(raw, await comfy.downloadFile(ref));
}
const output = path.join(directory, "robot-extend-67s.mp4");
await assembleWanVideo(raw, report.sourceAudioSnapshot, output, report.durationSeconds);
const rawFrames = await probeVideoFrameCount(raw);
if (rawFrames !== report.generatedFrames) throw new Error(`Nombre d’images natif incorrect : ${rawFrames}/${report.generatedFrames}.`);
const actualFrames = await probeVideoFrameCount(output);
const actualDuration = await probeDuration(output);
if (Math.abs(actualDuration - report.durationSeconds) > 1 / 16) throw new Error("La durée exportée est incorrecte.");

const times = [0, 10, 30, 45, 50, 60, Math.floor(report.durationSeconds - 1)];
for (const time of times) {
  const capture = path.join(directory, `frame-${String(time).padStart(2, "0")}s.png`);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(time), "-i", output, "-frames:v", "1", capture]);
}
const thumbnails = await Promise.all(times.map(async time => {
  const thumb = await sharp(path.join(directory, `frame-${String(time).padStart(2, "0")}s.png`)).resize(192, 256)
    .extend({ bottom: 28, background: "#fff" }).png().toBuffer();
  const label = Buffer.from(`<svg width="192" height="284"><text x="8" y="275" font-size="18" font-family="sans-serif">${time} s</text></svg>`);
  return sharp(thumb).composite([{ input: label }]).png().toBuffer();
}));
await sharp({ create: { width: 192 * times.length, height: 284, channels: 3, background: "#fff" } })
  .composite(thumbnails.map((input, index) => ({ input, left: index * 192, top: 0 }))).png()
  .toFile(path.join(directory, "contact-sheet.png"));

report.comfyOutput = ref;
report.output = output;
report.rawFrames = rawFrames;
report.actualFrames = actualFrames;
report.actualDuration = actualDuration;
report.elapsedSeconds = (Date.now() - Date.parse(report.startedAt)) / 1000;
report.status = "completed";
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const figures = times.map(time => `<figure><img src="frame-${String(time).padStart(2, "0")}s.png"><figcaption>${time} s</figcaption></figure>`).join("");
await fs.writeFile(path.join(directory, "validation.html"), `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Étape 3 · vidéo à valider</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;background:#14191f;color:#eee;padding:0 20px}video{width:100%;height:65vh;background:#090d11}button{font:inherit;padding:10px;margin:8px;cursor:pointer}.captures{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}figure{margin:0}img{width:100%}a{color:#b9d8ff}</style><h1>Étape 3 : vidéo à valider</h1><p>Même robot et son complet de 67 secondes. Le contexte visuel et les graines des étapes précédentes sont conservés ; le prompt demande maintenant un cadrage fixe.</p><video id="v" controls preload="metadata" src="robot-extend-67s.mp4"></video><div><button data-t="0">Début</button><button data-t="45">À partir de 45 s</button><button data-t="60">À partir de 60 s</button></div><p>Regarde surtout la fin de la vidéo, puis indique dans la conversation si le cadrage reste stable. La prochaine étape attend ton avis.</p><p><a href="robot-extend-67s.mp4" download>Télécharger la vidéo</a> · <a href="http://127.0.0.1:3033/validation.html" target="_blank" rel="noopener">Voir le rendu de l’étape 2</a></p><div class="captures">${figures}</div><script>document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{const v=document.getElementById('v');v.currentTime=Number(b.dataset.t);v.play()})</script></html>`);

const inputDir = process.env.COMFY_INPUT_DIR?.trim();
if (inputDir) {
  await fs.rm(path.join(inputDir, report.settings.audioName), { force: true });
  await fs.rm(path.join(inputDir, report.settings.imageName), { force: true });
}
console.log(JSON.stringify({ status: report.status, output, actualDuration, actualFrames, fps: 16,
  sourceAudioSnapshot: report.sourceAudioSnapshot, productionActivated: report.productionActivated }, null, 2));
