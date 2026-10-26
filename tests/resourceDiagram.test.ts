import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { diagramFromText, emptyDiagram, parseDiagramModel } from "../src/diagramModel.js";
import { renderResourceDiagram, resourceDiagramModel } from "../src/resourceDiagram.js";
import { ResourceStore } from "../src/resourceStore.js";

const source = () => JSON.stringify(diagramFromText("Texte du scénario → Génération de la voix → Montage vidéo"));
async function exportedPng(color = "#70d38f") {
  const rectangle = await sharp({ create: { width: 200, height: 100, channels: 4, background: color } }).png().toBuffer();
  const png = await sharp({ create: { width: 800, height: 140, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rectangle, left: 20, top: 20 }, { input: rectangle, left: 300, top: 20 }, { input: rectangle, left: 580, top: 20 }]).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("editable Apollon models preserve labels and links, and reject invalid structures before publication", () => {
  const original = source(); const model = resourceDiagramModel(original);
  assert.deepEqual(model.nodes.map(node => node.data.name), ["Texte du scénario", "Génération de la voix", "Montage vidéo"]);
  assert.equal(model.edges.length, 2); assert.equal(model.edges[0].source, model.nodes[0].id); assert.equal(model.edges[0].target, model.nodes[1].id);
  assert.equal(JSON.stringify(parseDiagramModel(original)), original);
  assert.deepEqual(diagramFromText("Entrée\nTraitement -> Sortie").nodes.map(node => node.data.name), ["Entrée", "Traitement", "Sortie"]);
  assert.throws(() => diagramFromText(""), { status: 400 });
  assert.throws(() => diagramFromText("Texte très long".repeat(30)), { status: 400 });
  for (const mutate of [
    (model: any) => { model.nodes[1].id = model.nodes[0].id; },
    (model: any) => { model.edges[0].target = "absent"; },
    (model: any) => { model.nodes[0].position.x = null; },
    (model: any) => { model.nodes[0].parentId = model.nodes[1].id; model.nodes[1].parentId = model.nodes[0].id; },
    (model: any) => { model.nodes[0].type = "inconnu"; },
    (model: any) => { model.nodes[0].width = -1; },
    (model: any) => { model.version = "99.0.0"; }
  ]) {
    const invalid = JSON.parse(original); mutate(invalid);
    assert.throws(() => resourceDiagramModel(JSON.stringify(invalid)), { status: 400 });
  }
  for (const invalid of [null, 42, "", "Entrée → Sortie", "{broken", '{"version":"4.2.0"}', "x".repeat(1024 * 1024 + 1)]) {
    assert.throws(() => resourceDiagramModel(invalid), { status: 400 });
  }
});

test("the PNG export is framed without clipping, keeps its colors and transparency, and rejects missing or corrupt images", async () => {
  const image = await renderResourceDiagram(source(), await exportedPng());
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1472); assert.equal(info.height, 1104); assert.equal(data[3], 0);
  let pixels = 0, colors = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const x = i / 4 % info.width, y = Math.floor(i / 4 / info.width);
    assert.ok(x >= 64 && x < info.width - 64 && y >= 64 && y < info.height - 64);
    pixels++;
    if (data[i] === 112 && data[i + 1] === 211 && data[i + 2] === 143) colors++;
  }
  assert.ok(pixels > 10_000 && colors > 10_000);
  for (const invalid of [undefined, 42, "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,broken", `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10]).toString("base64")}`]) {
    await assert.rejects(renderResourceDiagram(source(), invalid), { status: 400 });
  }
  const tooWide = await sharp({ create: { width: 4097, height: 1, channels: 4, background: "red" } }).png().toBuffer();
  await assert.rejects(renderResourceDiagram(source(), `data:image/png;base64,${tooWide.toString("base64")}`), { status: 400 });
  await assert.rejects(renderResourceDiagram(JSON.stringify(emptyDiagram()), await exportedPng()), { status: 400 });
});

test("diagram models, associations and PNGs survive restart; failed renders and disk writes retain the saved version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resource-diagram-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const background = await store.create({ name: "Fond", type: "image", source: "Un tableau." });
    const job = await store.beginImageGeneration(background.id);
    await store.finishImageGeneration(background.id, job.imageGeneration!.id,
      await sharp({ create: { width: 96, height: 72, channels: 3, background: "#308a76" } }).png().toBuffer());
    const original = await store.create({ name: "Schéma", type: "diagram", source: source(), backgroundImageId: background.id, diagramPreview: await exportedPng() });
    assert.ok(original.preview);
    const png = await readFile(store.previewPath(original.id)!);
    const index = path.join(root, "index.json"); const before = await readFile(index, "utf8");
    const files = await readdir(path.join(root, "previews"));
    const changed = JSON.parse(original.source); changed.nodes[0].data.name = "Texte modifié";
    for (const input of [
      { source: JSON.stringify(changed) }, { source: "{broken" },
      { source: JSON.stringify(changed), diagramPreview: "data:image/png;base64,bad" },
      { source: '{"version":"4.2.0"}', diagramPreview: await exportedPng() }
    ]) await assert.rejects(store.update(original.id, input), { status: 400 });
    assert.deepEqual(store.get(original.id), original);
    assert.equal(await readFile(index, "utf8"), before);
    assert.deepEqual(await readdir(path.join(root, "previews")), files);
    await rename(index, `${index}.backup`); await mkdir(index);
    await assert.rejects(store.update(original.id, { source: JSON.stringify(changed), diagramPreview: await exportedPng("#f08040") }));
    assert.deepEqual(store.get(original.id), original);
    assert.deepEqual(await readdir(path.join(root, "previews")), files);
    await rm(index, { recursive: true }); await rename(`${index}.backup`, index);
    const renamed = await store.update(original.id, { name: "Schéma renommé" });
    assert.equal(renamed.preview, original.preview); assert.deepEqual(await readFile(store.previewPath(original.id)!), png);
    await store.update(original.id, { source: JSON.stringify(changed), diagramPreview: await exportedPng("#f08040") });
    const restarted = new ResourceStore(root); await restarted.init();
    const reopened = restarted.get(original.id)!;
    assert.equal(JSON.parse(reopened.source).nodes[0].data.name, "Texte modifié");
    assert.equal(reopened.backgroundImageId, background.id);
    assert.notDeepEqual(await readFile(restarted.previewPath(original.id)!), png);
    const draft = await restarted.update(original.id, { source: JSON.stringify(emptyDiagram("ClassDiagram")) });
    assert.equal(draft.preview, undefined); assert.equal(JSON.parse(draft.source).type, "ClassDiagram");
    const legacy = await restarted.create({ name: "Ancien texte", type: "diagram", source: "Entrée → Sortie" });
    assert.equal(legacy.source, "Entrée → Sortie"); assert.equal(legacy.preview, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
