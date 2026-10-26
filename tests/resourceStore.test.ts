import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ResourceStore, type Resource } from "../src/resourceStore.js";
import sharp from "sharp";

async function generateBackground(store: ResourceStore, id: string) {
  const job = await store.beginImageGeneration(id);
  await store.finishImageGeneration(id, job.imageGeneration!.id,
    await sharp({ create: { width: 96, height: 72, channels: 3, background: "#308a76" } }).png().toBuffer());
}

async function withStore(run: (store: ResourceStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "resource-store-"));
  try {
    const store = new ResourceStore(root);
    await store.init();
    await run(store, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("all four resource sources and background associations survive editing and restart", async () => withStore(async (store, root) => {
  const image = await store.create({ name: "FondCours", type: "image", source: "  Un tableau sombre.\n" });
  await generateBackground(store, image.id);
  const sources = {
    latex: "\\frac{x^{2}}{y} + \\alpha",
    typescript: "\tconst nom: string = 'Émilie';\n\n  console.log(nom);\n",
    diagram: '{"nodes": [{"label": "Entrée"}], "edges": []}'
  };
  for (const [type, source] of Object.entries(sources)) {
    const resource = await store.create({ name: `Ressource-${type}`, type, source, backgroundImageId: image.id });
    assert.equal(resource.source, source);
    assert.equal(resource.backgroundImageId, image.id);
  }
  const empty = await store.create({ name: "Brouillon", type: "latex" });
  assert.equal(empty.source, "");
  await store.update(image.id, { name: "FondRenommé", source: "Nouveau fond." });
  const before = store.list();
  const legacyIndex = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  for (const resource of legacyIndex.resources) delete resource.latexColor;
  await writeFile(path.join(root, "index.json"), JSON.stringify(legacyIndex));
  const restarted = new ResourceStore(root);
  await restarted.init();
  assert.deepEqual(restarted.list(), before);
  for (const resource of restarted.list().filter(item => item.backgroundImageId)) assert.equal(resource.backgroundImageId, image.id);
  const detached = restarted.get(image.id)!;
  detached.name = "Mutation externe";
  assert.equal(restarted.get(image.id)!.name, "FondRenommé");
}));

test("invalid names, duplicate names, types, sources and backgrounds leave committed resources intact", async () => withStore(async (store, root) => {
  const image = await store.create({ name: "  Café  ", type: "image", source: "fond" });
  await generateBackground(store, image.id);
  assert.equal(image.name, "Café");
  const formula = await store.create({ name: "Formule", type: "latex", source: "x+1", backgroundImageId: image.id });
  const original = await readFile(path.join(root, "index.json"), "utf8");
  for (const input of [
    { name: "", type: "image" }, { name: "   ", type: "image" }, { name: "Nom}", type: "image" },
    { name: "Une\nligne", type: "image" }, { name: "x".repeat(121), type: "image" },
    { name: "Nouveau", type: "unknown" }, { name: "Nouveau", type: "latex", source: 12 },
    { name: "Nouveau", type: "latex", source: null },
    { name: "Nouveau", type: "latex", source: "x".repeat(1024 * 1024 + 1) },
    { name: "Nouveau", type: "latex", backgroundImageId: formula.id },
    { name: "Nouveau", type: "image", backgroundImageId: image.id },
    { name: "Nouveau", type: "latex", backgroundImageId: "../../escape" }
  ]) await assert.rejects(store.create(input), { status: 400 });
  for (const name of ["café", "CAFE\u0301", " Café "]) await assert.rejects(store.create({ name, type: "diagram" }), { status: 409 });
  await assert.rejects(store.update(formula.id, { name: "CAFÉ" }), { status: 409 });
  await assert.rejects(store.update(formula.id, { type: "image" }), { status: 400 });
  await assert.rejects(store.update("absent", { source: "x" }), { status: 404 });
  assert.equal(await readFile(path.join(root, "index.json"), "utf8"), original);
  assert.equal(store.get(formula.id)!.source, "x+1");
}));

test("concurrent resource saves serialize duplicate checks and preserve every successful write", async () => withStore(async (store, root) => {
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => store.create({ name: "Unique", type: "image" })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const distinct = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create({ name: `Nom-${i}`, type: "typescript", source: `const i = ${i};` })));
  await Promise.all(distinct.map(resource => store.update(resource.id, { source: `${resource.source}\n// sauvegardé` })));
  const restarted = new ResourceStore(root);
  await restarted.init();
  assert.equal(restarted.list().length, 9);
  for (const resource of distinct) assert.match(restarted.get(resource.id)!.source, /sauvegardé$/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith(".")), []);
}));

test("a failed disk commit preserves memory and the queue can save again", async () => withStore(async (store, root) => {
  const resource = await store.create({ name: "Original", type: "diagram", source: "source initiale" });
  const file = path.join(root, "index.json");
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(store.update(resource.id, { name: "Perdu", source: "non enregistré" }));
  assert.deepEqual(store.get(resource.id), resource);
  await rm(file, { recursive: true });
  await rename(`${file}.backup`, file);
  const saved = await store.update(resource.id, { name: "Sauvé" });
  assert.equal(saved.name, "Sauvé");
  const restarted = new ResourceStore(root);
  await restarted.init();
  assert.equal(restarted.get(resource.id)!.source, "source initiale");
}));

test("unreadable or inconsistent library data is rejected without overwriting it", async () => withStore(async (_store, root) => {
  const record: Resource = { id: "6e56674b-121a-4ef9-906a-dc7912b091d6", name: "Image", type: "image", source: "fond", createdAt: 1, updatedAt: 1 };
  const cases = ["{broken", JSON.stringify({ version: 99, resources: [] }),
    JSON.stringify({ version: 1, resources: [record, record] }),
    JSON.stringify({ version: 1, resources: [{ ...record, preview: "../../secret.png" }] }),
    JSON.stringify({ version: 1, resources: [{ ...record, type: "latex", backgroundImageId: "f0198a2b-121a-4ef9-906a-dc7912b091d6" }] })];
  for (const value of cases) {
    await writeFile(path.join(root, "index.json"), value);
    await assert.rejects(new ResourceStore(root).init());
    assert.equal(await readFile(path.join(root, "index.json"), "utf8"), value);
  }
}));

test("preview metadata for resource types without a renderer is preserved on rename and invalidated on background changes", async () => withStore(async (store, root) => {
  const image = await store.create({ name: "Image", type: "image", source: "fond" });
  const diagram = await store.create({ name: "Diagramme", type: "diagram", source: "Entrée → Sortie", backgroundImageId: image.id });
  const data = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  data.resources.find((resource: Resource) => resource.id === diagram.id).preview = `${diagram.id}.png`;
  await writeFile(path.join(root, "index.json"), JSON.stringify(data));
  const loaded = new ResourceStore(root);
  await loaded.init();
  assert.equal(loaded.previewPath(diagram.id), path.join(root, "previews", `${diagram.id}.png`));
  await loaded.update(diagram.id, { name: "Diagramme renommé" });
  assert.ok(loaded.previewPath(diagram.id));
  await loaded.update(diagram.id, { backgroundImageId: null });
  assert.equal(loaded.previewPath(diagram.id), undefined);
  assert.equal(loaded.get(diagram.id)!.backgroundImageId, undefined);
}));
