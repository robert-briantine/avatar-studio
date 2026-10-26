import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { diagramFromText, emptyDiagram } from "../src/diagramModel.js";

test("diagram API validates editable models and PNGs, shares the saved preview and preserves diagrams after failure and restart", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "resource-diagram-api-"));
  let app: ReturnType<typeof spawn> | undefined;
  let origin: string;
  let output = "";
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
    await start();
    const request = (url: string, body: unknown, method = "POST") => fetch(`${origin}${url}`, { method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const source = JSON.stringify(diagramFromText("Entrée → Traitement → Sortie"));
    const png = await sharp({ create: { width: 800, height: 240, channels: 4, background: "#70d38f" } }).png().toBuffer();
    const body = { source, diagramPreview: `data:image/png;base64,${png.toString("base64")}` };
    const preview = await request("/api/resources/diagram/preview", body);
    assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
    const live = await preview.json(); assert.equal(live.width, 1472); assert.equal(live.height, 1104);
    const image = Buffer.from(live.image.split(",")[1], "base64"); assert.equal((await sharp(image).metadata()).hasAlpha, true);
    assert.deepEqual((await (await fetch(`${origin}/api/resources`)).json()).resources, []);
    for (const invalid of [{ source }, { ...body, source: "{broken" }, { ...body, diagramPreview: "data:image/svg+xml;base64,PHN2Zy8+" }, { ...body, source: JSON.stringify(emptyDiagram()) }]) {
      const response = await request("/api/resources/diagram/preview", invalid); assert.equal(response.status, 400); assert.ok((await response.json()).error);
    }
    const created = await request("/api/resources", { name: "MonSchéma", type: "diagram", ...body }); assert.equal(created.status, 201);
    const resource = (await created.json()).resource; assert.equal(resource.source, source); assert.ok(resource.previewUrl);
    assert.equal(resource.diagramPreview, undefined, "the input PNG is not duplicated in the index or resource responses");
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${resource.previewUrl}`)).arrayBuffer()), image);
    const index = path.join(directory, "resources/index.json"); const before = await readFile(index, "utf8");
    for (const imported of [JSON.parse(source), emptyDiagram("ClassDiagram")]) {
      const response = await request("/api/resources/diagram/import", { source: JSON.stringify(imported, null, 2) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(JSON.parse((await response.json()).source), imported, "import preserves the complete native model, including empty diagrams");
    }
    const badNode = JSON.parse(source); badNode.nodes[0].type = "inconnu";
    const badLink = JSON.parse(source); badLink.edges[0].target = "absent";
    for (const invalid of [undefined, "{broken", "Entrée → Sortie", JSON.stringify(badNode), JSON.stringify(badLink), "x".repeat(1024 * 1024 + 1)]) {
      const response = await request("/api/resources/diagram/import", { source: invalid });
      assert.equal(response.status, 400); assert.ok((await response.json()).error);
    }
    assert.equal(await readFile(index, "utf8"), before, "validating imports must not save or modify library resources");
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${resource.previewUrl}`)).arrayBuffer()), image);
    const changed = JSON.parse(source); changed.nodes[0].data.name = "Entrée modifiée";
    for (const body of [{ source: JSON.stringify(changed) }, { source: "{broken" }, { source: JSON.stringify(changed), diagramPreview: "data:image/png;base64,bad" }]) {
      assert.equal((await request(`/api/resources/${resource.id}`, body, "PATCH")).status, 400);
    }
    assert.equal(await readFile(index, "utf8"), before);
    assert.deepEqual((await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource, resource);
    await stop(); await start();
    assert.deepEqual((await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource, resource);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${resource.previewUrl}`)).arrayBuffer()), image);
    const draft = await request("/api/resources", { name: "Brouillon", type: "diagram", source: JSON.stringify(emptyDiagram("ClassDiagram")) });
    assert.equal(draft.status, 201); assert.equal((await draft.json()).resource.previewUrl, undefined);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
