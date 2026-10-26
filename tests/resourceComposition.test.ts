import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { ResourceStore } from "../src/resourceStore.js";
import { diagramFromText } from "../src/diagramModel.js";
import { renderResourceLatex } from "../src/latex.js";
import { renderResourceCode, renderResourceCodeContent } from "../src/resourceCode.js";
import { renderResourceDiagram } from "../src/resourceDiagram.js";
import { composeResourceVisual, resourceComposition } from "../src/resourceComposition.js";

const png = (color: string, width = 400, height = 300) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
const diagramSource = () => JSON.stringify(diagramFromText("Scénario → Voix → Vidéo"));
const dataUrl = (image: Buffer) => `data:image/png;base64,${image.toString("base64")}`;
const pixel = async (image: Buffer, left = 0, top = 0) => [...await sharp(image).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
async function generated(store: ResourceStore, id: string, color: string) {
  const job = await store.beginImageGeneration(id);
  return store.finishImageGeneration(id, job.imageGeneration!.id, await png(color));
}

test("all three compositions show the background around a readable foreground, retain code colors and honor position and margins", async () => {
  const background = await png("#308a76");
  const code = '\tconst valeur: number = 42;\n\nconsole.log(valeur);\n';
  assert.deepEqual(await renderResourceCodeContent(code), await renderResourceCodeContent(code.replace("\t", "    ")));
  const oneLine = await sharp(await renderResourceCodeContent("const x = 1;")).metadata();
  const blankLines = await sharp(await renderResourceCodeContent("const x = 1;\n\n")).metadata();
  assert.equal(blankLines.height! - oneLine.height!, 96, "the composition content retains blank and trailing source lines");
  const cases = [
    { type: "latex" as const, source: "E = mc^2", foreground: await renderResourceLatex("E = mc^2") },
    { type: "typescript" as const, source: code, codeTheme: "dark-plus", foreground: await renderResourceCode(code) },
    { type: "diagram" as const, source: diagramSource(), foreground: await renderResourceDiagram(diagramSource(), dataUrl(await png("#ef8040", 800, 200))) }
  ];
  for (const item of cases) {
    const image = await composeResourceVisual({ ...item, composition: resourceComposition({ position: "bottom-right", margin: 80, sizePercent: 65 }) }, item.foreground, background);
    assert.deepEqual(await pixel(image), [48, 138, 118]);
    const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1472); assert.equal(info.height, 1104);
    let minX = info.width, minY = info.height, maxX = 0, maxY = 0, codeColor = 0, whitePixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      assert.equal(data[i + 3], 255);
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) whitePixels++;
      // Resizing antialiased glyphs can shift channels by a few integer values.
      if (Math.abs(data[i] - 86) + Math.abs(data[i + 1] - 156) + Math.abs(data[i + 2] - 214) < 6) codeColor++;
      if (data[i] === 48 && data[i + 1] === 138 && data[i + 2] === 118) continue;
      const x = i / 4 % info.width, y = Math.floor(i / 4 / info.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    assert.ok(maxX <= 1472 - 80 - 1 && maxY <= 1104 - 80 - 1);
    assert.ok(minX >= 80 && minY >= 80, "no foreground may cross the requested margin");
    if (item.type === "typescript") {
      assert.equal(maxX, 1472 - 80 - 1); assert.equal(maxY, 1104 - 80 - 1);
      assert.ok(codeColor > 20, "the composed PNG retains the selected syntax palette");
    } else {
      assert.equal(whitePixels, 0, "LaTeX and diagrams overlay the background without an opaque white panel");
    }
  }
});

test("the whole-image background setting preserves portrait images while cover fills the frame; invalid settings are rejected", async () => {
  const background = await png("#ef8040", 200, 400);
  const foreground = await renderResourceLatex("x+1");
  const whole = await composeResourceVisual({ type: "latex", source: "x+1" }, foreground, background);
  assert.deepEqual(await pixel(whole), [19, 38, 30]);
  assert.deepEqual(await pixel(whole, 736, 0), [239, 128, 64]);
  const cover = await composeResourceVisual({ type: "latex", source: "x+1", composition: resourceComposition({ backgroundFit: "cover" }) }, foreground, background);
  assert.deepEqual(await pixel(cover), [239, 128, 64]);
  for (const value of [null, [], { position: "outside" }, { margin: 0 }, { margin: 161 }, { sizePercent: 100 }, { sizePercent: "80" }, { backgroundFit: "stretch" }]) {
    assert.throws(() => resourceComposition(value), { status: 400 });
  }
});

test("shared backgrounds and settings survive restart and renaming; regenerated images refresh compositions without compounding their foreground", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resource-composition-"));
  try {
    const store = new ResourceStore(root); await store.init();
    let background = await store.create({ name: "Fond commun", type: "image", source: "Un fond." });
    background = await generated(store, background.id, "#308a76");
    const backgroundBytes = await readFile(store.previewPath(background.id)!);
    const composition = resourceComposition({ position: "top-left", sizePercent: 60, margin: 80 });
    const model = diagramSource();
    const resources = await Promise.all([
      store.create({ name: "Formule", type: "latex", source: "E = mc^2", backgroundImageId: background.id, composition }),
      store.create({ name: "Code", type: "typescript", source: '\tconst nom = "Émilie";\n', backgroundImageId: background.id, composition }),
      store.create({ name: "Schéma", type: "diagram", source: model, diagramPreview: dataUrl(await png("#ef8040", 800, 200)), backgroundImageId: background.id, composition })
    ]);
    assert.deepEqual(await readFile(store.previewPath(background.id)!), backgroundBytes, "composition must reuse, never regenerate or modify, the image");
    for (const resource of resources) {
      assert.ok(resource.foreground && resource.preview && resource.foreground !== resource.preview);
      assert.equal(resource.backgroundPreview, background.preview); assert.deepEqual(resource.composition, composition);
      assert.deepEqual(await pixel(await readFile((await store.resolvePreview(resource.id))!)), [48, 138, 118]);
    }
    const restarted = new ResourceStore(root); await restarted.init();
    for (const resource of resources) assert.deepEqual(restarted.get(resource.id), resource);
    await restarted.update(background.id, { name: "Fond renommé" });
    for (const resource of resources) {
      assert.equal(restarted.get(resource.id)!.backgroundImageId, background.id);
      assert.equal(await restarted.resolvePreview(resource.id), path.join(root, "previews", resource.preview!));
    }
    await restarted.update(background.id, { source: "Un nouveau fond." });
    await generated(restarted, background.id, "#2848a0");
    for (const resource of resources) {
      const output = await readFile((await restarted.resolvePreview(resource.id))!);
      assert.deepEqual(await pixel(output), [40, 72, 160]);
      assert.equal(restarted.get(resource.id)!.source, resource.source);
      assert.deepEqual(restarted.get(resource.id)!.composition, composition);
    }
    const diagram = resources[2]; const original = await readFile(path.join(root, "previews", diagram.foreground!));
    assert.equal(restarted.get(diagram.id)!.foreground, diagram.foreground);
    await restarted.update(diagram.id, { composition: { ...composition, position: "bottom-right" } });
    assert.equal(restarted.get(diagram.id)!.foreground, diagram.foreground);
    const detached = await restarted.update(diagram.id, { backgroundImageId: "" });
    assert.equal(detached.backgroundImageId, undefined); assert.equal(detached.backgroundPreview, undefined);
    assert.deepEqual(await readFile(restarted.previewPath(diagram.id)!), original, "removing a background must restore the original diagram PNG");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unavailable backgrounds and failed publication preserve the previous source, association and both PNGs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resource-composition-error-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const background = await store.create({ name: "Fond requis", type: "image", source: "Un fond." });
    await assert.rejects(store.create({ name: "Invalide", type: "latex", source: "x+1", backgroundImageId: background.id }), /Fond requis.*pas disponible/);
    await generated(store, background.id, "#308a76");
    const resource = await store.create({ name: "Formule", type: "latex", source: "x+1", backgroundImageId: background.id });
    const index = path.join(root, "index.json"); const before = await readFile(index, "utf8");
    const files = await readdir(path.join(root, "previews"));
    const savedPng = await readFile(store.previewPath(resource.id)!);
    const backgroundPath = store.previewPath(background.id)!; const originalBackground = await readFile(backgroundPath);
    await writeFile(backgroundPath, "corrompu");
    await assert.rejects(store.resolvePreview(resource.id), /Fond requis.*absente ou illisible/);
    await assert.rejects(store.update(resource.id, { source: "x+2" }), { status: 400 });
    await assert.rejects(store.composePreview("latex", { source: "x+1", backgroundImageId: background.id }, await renderResourceLatex("x+1")), { status: 400 });
    await rm(backgroundPath);
    await assert.rejects(store.resolvePreview(resource.id), { status: 400 });
    await writeFile(backgroundPath, originalBackground);
    await assert.rejects(store.update(resource.id, { composition: { margin: 1000 } }), { status: 400 });
    assert.deepEqual(store.get(resource.id), resource); assert.equal(await readFile(index, "utf8"), before);
    assert.deepEqual(await readFile(store.previewPath(resource.id)!), savedPng);
    await rename(index, `${index}.backup`); await mkdir(index);
    await assert.rejects(store.update(resource.id, { source: "x+2" }));
    assert.deepEqual(store.get(resource.id), resource);
    assert.deepEqual((await readdir(path.join(root, "previews"))).sort(), files.sort(), "neither an unpublished foreground nor composition may remain");
    await rm(index, { recursive: true }); await rename(`${index}.backup`, index);
    const restored = await store.update(resource.id, { source: "x+2" }); assert.equal(restored.source, "x+2");
  } finally { await rm(root, { recursive: true, force: true }); }
});
