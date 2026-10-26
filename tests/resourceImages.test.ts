import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { ResourceStore } from "../src/resourceStore.js";
import { ResourceImages } from "../src/resourceImages.js";

const png = (background = "red") => sharp({ create: { width: 64, height: 48, channels: 3, background } }).png().toBuffer();

async function withStore(run: (store: ResourceStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "resource-images-"));
  try { const store = new ResourceStore(root); await store.init(); await run(store, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function completed(store: ResourceStore, id: string, status = "done") {
  for (let i = 0; i < 400; i++) {
    const resource = store.get(id)!;
    if (resource.imageGeneration?.status !== "running") {
      assert.equal(resource.imageGeneration?.status, status, resource.imageGeneration?.error);
      return resource;
    }
    await delay(5);
  }
  assert.fail("Image generation did not finish");
}

test("named image generation preserves pixels across reuse and restart, then repairs missing or corrupt outputs", async () => withStore(async (store, root) => {
  const resource = await store.create({ name: "FondCours", type: "image", source: "  Un tableau sombre.\n" });
  let calls = 0;
  const descriptions: string[] = [];
  const generate = async (description: string) => { calls++; descriptions.push(description); return png(); };
  const images = new ResourceImages(store, generate);
  await images.start(resource.id);
  const ready = await completed(store, resource.id);
  assert.equal(ready.source, resource.source);
  assert.ok(ready.preview);
  const pixels = await readFile(store.previewPath(resource.id)!);
  assert.equal((await sharp(pixels).metadata()).width, 64);
  await images.start(resource.id);
  assert.equal((await completed(store, resource.id)).imageGeneration!.reused, true);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(store.previewPath(resource.id)!), pixels);
  const restarted = new ResourceStore(root);
  await restarted.init();
  const afterRestart = new ResourceImages(restarted, generate);
  await afterRestart.start(resource.id);
  await completed(restarted, resource.id);
  assert.equal(calls, 1);
  await rm(restarted.previewPath(resource.id)!);
  await afterRestart.start(resource.id);
  await completed(restarted, resource.id);
  assert.equal(calls, 2);
  await writeFile(restarted.previewPath(resource.id)!, "broken pixels");
  await afterRestart.start(resource.id);
  await completed(restarted, resource.id);
  assert.equal(calls, 3);
  await restarted.update(resource.id, { source: "Un paysage clair." });
  assert.equal(restarted.previewPath(resource.id), undefined);
  assert.equal(restarted.get(resource.id)!.imageGeneration, undefined);
  await afterRestart.start(resource.id);
  await completed(restarted, resource.id);
  assert.equal(descriptions.at(-1), "Un paysage clair.");
}));

test("active image generation rejects edits and duplicate starts and cancellation leaves other resources running", async () => withStore(async store => {
  const first = await store.create({ name: "Premier", type: "image", source: "premier" });
  const second = await store.create({ name: "Second", type: "image", source: "second" });
  let finishSecond!: () => void;
  const gate = new Promise<void>(resolve => { finishSecond = resolve; });
  const images = new ResourceImages(store, async (description, signal) => {
    if (description === "premier") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    else await gate;
    return png();
  });
  await images.start(first.id);
  await images.start(second.id);
  await assert.rejects(images.start(first.id), { status: 409 });
  await assert.rejects(store.update(first.id, { source: "source concurrente" }), { status: 409 });
  images.stop(first.id);
  const cancelled = await completed(store, first.id, "interrupted");
  assert.equal(cancelled.preview, undefined);
  assert.equal(store.get(second.id)!.imageGeneration!.status, "running");
  finishSecond();
  await completed(store, second.id);
  await store.update(first.id, { source: "source modifiable après arrêt" });
}));

test("invalid requests and failed or unreadable generations never publish a ready image", async () => withStore(async (store, root) => {
  const formula = await store.create({ name: "Formule", type: "latex", source: "x+1" });
  const blank = await store.create({ name: "Brouillon", type: "image", source: " " });
  const image = await store.create({ name: "Image", type: "image", source: "fond" });
  const previousPreviews = await readdir(path.join(root, "previews"));
  const failed = new ResourceImages(store, async () => { throw new Error("Qwen indisponible"); });
  await assert.rejects(failed.start("unknown"), { status: 404 });
  await assert.rejects(failed.start(formula.id), { status: 400 });
  await assert.rejects(failed.start(blank.id), { status: 400 });
  await failed.start(image.id);
  assert.match((await completed(store, image.id, "error")).imageGeneration!.error!, /Qwen/);
  const invalid = new ResourceImages(store, async () => Buffer.from("not an image"));
  await invalid.start(image.id);
  assert.equal((await completed(store, image.id, "error")).preview, undefined);
  assert.deepEqual(await readdir(path.join(root, "previews")), previousPreviews);
}));

test("unfinished image jobs become persistently interrupted on restart and can be retried", async () => withStore(async (store, root) => {
  const image = await store.create({ name: "En cours", type: "image", source: "un fond" });
  await store.beginImageGeneration(image.id);
  const restarted = new ResourceStore(root);
  await restarted.init();
  assert.equal(restarted.get(image.id)!.imageGeneration!.status, "interrupted");
  const again = new ResourceStore(root);
  await again.init();
  assert.equal(again.get(image.id)!.imageGeneration!.status, "interrupted");
  const images = new ResourceImages(again, async () => png());
  await images.start(image.id);
  assert.ok((await completed(again, image.id)).preview);
}));

test("failed publication and duplicate completion preserve the previously committed PNG", async () => withStore(async (store, root) => {
  const image = await store.create({ name: "Image", type: "image", source: "fond" });
  const first = await store.beginImageGeneration(image.id);
  await store.finishImageGeneration(image.id, first.imageGeneration!.id, await png());
  const previousPath = store.previewPath(image.id)!;
  const previousPixels = await readFile(previousPath);
  const next = await store.beginImageGeneration(image.id);
  const index = path.join(root, "index.json");
  await rename(index, `${index}.backup`);
  await mkdir(index);
  await assert.rejects(store.finishImageGeneration(image.id, next.imageGeneration!.id, await png("green")));
  assert.equal(store.previewPath(image.id), previousPath);
  assert.deepEqual(await readFile(previousPath), previousPixels);
  assert.deepEqual(await readdir(path.join(root, "previews")), [path.basename(previousPath)]);
  await rm(index, { recursive: true });
  await rename(`${index}.backup`, index);
  const data = await png("blue");
  const attempts = await Promise.allSettled([
    store.finishImageGeneration(image.id, next.imageGeneration!.id, data),
    store.finishImageGeneration(image.id, next.imageGeneration!.id, data)
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(await readFile(store.previewPath(image.id)!));
  assert.equal((await sharp(store.previewPath(image.id)!).metadata()).format, "png");
}));
