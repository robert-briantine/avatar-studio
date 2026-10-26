import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { ResourceStore } from "../src/resourceStore.js";
import { diagramFromText } from "../src/diagramModel.js";

test("all preview APIs publish the same composition as saving, retain settings after restart and reject a missing background before exposing a rendered visual", { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "resource-composition-api-"));
  let app: ReturnType<typeof spawn> | undefined, origin = "", output = "";
  const start = async () => {
    const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve())); origin = `http://127.0.0.1:${port}`;
    app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory, COMFY_URL: "http://127.0.0.1:1", TTS_URL: "http://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"] });
    app.stdout!.on("data", bytes => { output += bytes; }); app.stderr!.on("data", bytes => { output += bytes; });
    for (let i = 0; i < 160; i++) { try { if ((await fetch(`${origin}/api/resources`)).ok) return; } catch {} await delay(25); }
    assert.fail(`Server did not start: ${output}`);
  };
  const stop = async () => {
    if (app && app.exitCode === null && app.signalCode === null) { const closed = once(app, "close"); app.kill("SIGTERM"); await closed; }
  };
  try {
    const store = new ResourceStore(path.join(directory, "resources")); await store.init();
    let background = await store.create({ name: "Fond partagé", type: "image", source: "Un fond." });
    const job = await store.beginImageGeneration(background.id);
    background = await store.finishImageGeneration(background.id, job.imageGeneration!.id,
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "#308a76" } }).png().toBuffer());
    const backgroundPath = store.previewPath(background.id)!; const backgroundPng = await readFile(backgroundPath);
    await start();
    const request = (url: string, body: unknown, method = "POST") => fetch(`${origin}${url}`, { method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const composition = { position: "bottom-right", sizePercent: 65, margin: 80, backgroundFit: "cover" };
    const diagramPng = await sharp({ create: { width: 800, height: 240, channels: 4, background: "#ef8040" } }).png().toBuffer();
    const records = [];
    for (const body of [
      { type: "latex", source: String.raw`\frac{x+1}{y}`, latexColor: "#e83050" },
      { type: "typescript", source: '\tconst prénom = "Émilie";  \r\n', codeTheme: "light-plus" },
      { type: "diagram", source: JSON.stringify(diagramFromText("Scénario → Voix → Vidéo")), diagramPreview: `data:image/png;base64,${diagramPng.toString("base64")}` }
    ]) {
      const payload = { ...body, backgroundImageId: background.id, composition };
      const preview = await request(`/api/resources/${body.type}/preview`, payload);
      assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
      const live = await preview.json(); assert.equal(live.width, 1472); assert.equal(live.height, 1104);
      const before = await readFile(path.join(directory, "resources/index.json"), "utf8");
      const invalid = await request(`/api/resources/${body.type}/preview`, { ...payload, composition: { sizePercent: 100 } });
      assert.equal(invalid.status, 400); assert.equal(await readFile(path.join(directory, "resources/index.json"), "utf8"), before);
      const create = await request("/api/resources", { ...payload, name: `Composition-${body.type}` }); assert.equal(create.status, 201);
      const record = (await create.json()).resource;
      assert.equal(record.source, body.source); assert.equal(record.backgroundImageId, background.id); assert.deepEqual(record.composition, composition);
      if (body.type === "latex") {
        assert.equal(record.latexColor, body.latexColor);
        const pixels = await sharp(Buffer.from(live.image.split(",")[1], "base64")).ensureAlpha().raw().toBuffer();
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === 232 && pixels[i + 1] === 48 && pixels[i + 2] === 80 && pixels[i + 3] === 255) colored++;
        }
        assert.ok(colored > 100, "the selected formula color survives composition on the generated background");
      }
      assert.equal(record.foreground, undefined); assert.equal(record.backgroundPreview, undefined); assert.equal(record.diagramPreview, undefined);
      const rendered = await fetch(`${origin}${record.previewUrl}`); assert.equal(rendered.status, 200);
      assert.equal(rendered.headers.get("cache-control"), "no-store");
      assert.deepEqual(Buffer.from(await rendered.arrayBuffer()), Buffer.from(live.image.split(",")[1], "base64"));
      records.push(record);
    }
    assert.deepEqual(await readFile(backgroundPath), backgroundPng);
    await stop(); await start();
    for (const record of records) {
      assert.deepEqual((await (await fetch(`${origin}/api/resources/${record.id}`)).json()).resource, record);
      assert.equal((await fetch(`${origin}${record.previewUrl}`)).status, 200);
    }
    const before = await readFile(path.join(directory, "resources/index.json"), "utf8");
    await rm(backgroundPath);
    for (const record of records) {
      const unavailable = await fetch(`${origin}${record.previewUrl}`); assert.equal(unavailable.status, 400);
      assert.match((await unavailable.json()).error, /Fond partagé.*absente ou illisible/);
      const save = await request(`/api/resources/${record.id}`, { composition: { ...composition, margin: 96 } }, "PATCH");
      assert.equal(save.status, 400);
      assert.deepEqual((await (await fetch(`${origin}/api/resources/${record.id}`)).json()).resource, record);
    }
    assert.equal(await readFile(path.join(directory, "resources/index.json"), "utf8"), before);
    await writeFile(backgroundPath, backgroundPng);
    const diagram = records.find(record => record.type === "diagram")!;
    const detached = await request(`/api/resources/${diagram.id}`, { backgroundImageId: "" }, "PATCH");
    assert.equal(detached.status, 200); assert.equal((await detached.json()).resource.backgroundImageId, undefined);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
