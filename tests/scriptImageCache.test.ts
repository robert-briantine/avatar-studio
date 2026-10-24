import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { ScriptImageCache } from "../src/scriptImageCache.js";

const png = () => sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();

test("identical image descriptions reuse disk pixels after restart and keep distinct keys", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-image-cache-"));
  try {
    let calls = 0;
    const generate = async () => { calls++; return png(); };
    const cache = new ScriptImageCache(directory);
    await cache.init();
    const first = await cache.get("une licorne", generate);
    assert.equal((await cache.get("une licorne", generate)).path, first.path);
    const restarted = new ScriptImageCache(directory);
    await restarted.init();
    assert.deepEqual(await restarted.get("une licorne", generate), first);
    assert.equal(calls, 1);
    for (const key of ["Une licorne", "une  licorne", "__proto__", "../../autre/image"]) {
      const other = await restarted.get(key, generate);
      assert.notEqual(other.path, first.path);
      assert.equal(path.dirname(other.path), directory);
    }
    const index = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
    assert.equal(index.version, 1);
    assert.equal(index.images.length, 5);
    assert.deepEqual(index.images.map((image: { content: string }) => image.content), ["une licorne", "Une licorne", "une  licorne", "__proto__", "../../autre/image"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent image requests share generation and serialize dictionary commits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-image-concurrent-"));
  try {
    const cache = new ScriptImageCache(directory);
    await cache.init();
    let calls = 0;
    const generate = async () => { calls++; return png(); };
    const images = await Promise.all(Array.from({ length: 8 }, () => cache.get("licorne", generate)));
    assert.equal(calls, 1);
    assert.ok(images.every(image => image.path === images[0].path));
    await Promise.all(["dragon", "robot", "paysage"].map(key => cache.get(key, generate)));
    const restarted = new ScriptImageCache(directory);
    await restarted.init();
    const forbidden = async (): Promise<Buffer> => { throw new Error("must reuse cached image"); };
    for (const key of ["licorne", "dragon", "robot", "paysage"]) await restarted.get(key, forbidden);
    assert.equal(calls, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing and damaged images regenerate without duplicating the dictionary key", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-image-repair-"));
  try {
    const cache = new ScriptImageCache(directory);
    await cache.init();
    let calls = 0;
    const generate = async () => { calls++; return png(); };
    const image = await cache.get("licorne", generate);
    await rm(image.path);
    await cache.get("licorne", generate);
    await writeFile(image.path, "invalid pixels");
    await cache.get("licorne", generate);
    assert.equal(calls, 3);
    assert.equal((JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"))).images.length, 1);
    assert.equal((await sharp(image.path).metadata()).format, "png");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed or cancelled image generation leaves no cache entry and can be retried", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-image-error-"));
  try {
    const cache = new ScriptImageCache(directory);
    await cache.init();
    await assert.rejects(cache.get("licorne", async () => { throw new Error("generation failed"); }), /generation failed/);
    await assert.rejects(cache.get("licorne", async () => Buffer.from("not an image")));
    const controller = new AbortController();
    await assert.rejects(cache.get("licorne", async () => { controller.abort(); return png(); }, controller.signal), { name: "AbortError" });
    assert.deepEqual(await readdir(directory), []);
    await cache.get("licorne", png);
    assert.equal((JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"))).images.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancelling a cache waiter does not interrupt the owner generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-image-waiter-"));
  try {
    const cache = new ScriptImageCache(directory);
    await cache.init();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const owner = cache.get("licorne", async () => { await gate; return png(); });
    const controller = new AbortController();
    const waiter = cache.get("licorne", async () => { throw new Error("duplicate generation"); }, controller.signal);
    controller.abort();
    await assert.rejects(waiter, { name: "AbortError" });
    resume();
    const result = await owner;
    assert.equal((await sharp(result.path).metadata()).width, 32);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
