import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Resource } from "../src/resourceStore.js";

test("resource image API uses Qwen, reuses stored images, reports errors and cancels only the selected job", { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "resource-image-api-"));
  const pixels = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#70d38f" } }).png().toBuffer();
  const prompts: Array<{ id: string; text: string; graph: Record<string, any> }> = [];
  const cancelled: string[] = [];
  const forbidden: string[] = [];
  const comfy = createServer(async (req, res) => {
    const json = (data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
    if (req.url === "/prompt") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const graph = JSON.parse(Buffer.concat(chunks).toString()).prompt;
      const id = randomUUID();
      prompts.push({ id, text: graph["4"].inputs.text, graph });
      json({ prompt_id: id });
    } else if (req.url?.startsWith("/history/")) {
      const prompt = prompts.find(prompt => prompt.id === req.url!.split("/").at(-1));
      if (!prompt || prompt.text.startsWith("Lent")) json({});
      else if (prompt.text.startsWith("Erreur")) json({ [prompt.id]: { status: { status_str: "error" }, outputs: {} } });
      else json({ [prompt.id]: { status: { status_str: "success" }, outputs: { save: { images: [{ filename: `${prompt.id}.png` }] } } } });
    } else if (req.url?.startsWith("/view?")) {
      res.setHeader("content-type", "image/png"); res.end(pixels);
    } else if (req.url?.startsWith("/api/jobs/") && req.url.endsWith("/cancel")) {
      cancelled.push(req.url.split("/")[3]); json({ cancelled: true });
    } else {
      if (["/interrupt", "/free"].includes(req.url!)) forbidden.push(req.url!);
      res.writeHead(404).end();
    }
  });
  let app: ReturnType<typeof spawn> | undefined;
  let origin: string;
  let output = "";
  const stop = async () => {
    if (app && app.exitCode === null && app.signalCode === null) { const closed = once(app, "close"); app.kill("SIGTERM"); await closed; }
  };
  const start = async () => {
    const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory,
        COMFY_URL: `http://127.0.0.1:${(comfy.address() as { port: number }).port}`, TTS_URL: "http://127.0.0.1:1" }, stdio: ["ignore", "pipe", "pipe"] });
    app.stdout!.on("data", bytes => { output += bytes; }); app.stderr!.on("data", bytes => { output += bytes; });
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/api/resources`)).ok) return; } catch {} await delay(25); }
    assert.fail(`Server did not start: ${output}`);
  };
  try {
    comfy.listen(0, "127.0.0.1"); await once(comfy, "listening"); await start();
    const request = (route: string, body?: unknown, method = "POST") => fetch(`${origin}${route}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const create = async (name: string, source: string, type = "image"): Promise<Resource> =>
      (await (await request("/api/resources", { name, source, type })).json()).resource;
    const get = async (id: string): Promise<Resource & { previewUrl?: string }> => (await (await fetch(`${origin}/api/resources/${id}`)).json()).resource;
    const generate = (id: string) => request(`/api/resources/${id}/generate-image`);
    const completed = async (id: string, expected = "done") => {
      for (let i = 0; i < 300; i++) {
        const resource = await get(id);
        if (resource.imageGeneration?.status !== "running") {
          assert.equal(resource.imageGeneration?.status, expected, `${resource.imageGeneration?.error}\n${output}`); return resource;
        }
        await delay(15);
      }
      assert.fail(`Generation did not finish: ${output}`);
    };
    const blank = await create("Brouillon", "");
    const formula = await create("Formule", "x+1", "latex");
    assert.equal((await generate(blank.id)).status, 400);
    assert.equal((await generate(formula.id)).status, 400);
    assert.equal((await generate("unknown")).status, 404);
    assert.equal(prompts.length, 0);
    const image = await create("FondCours", "Un tableau sombre pour un cours.");
    assert.equal((await generate(image.id)).status, 202);
    let ready = await completed(image.id);
    assert.ok(ready.previewUrl);
    const graph = prompts[0].graph;
    assert.ok(prompts[0].text.startsWith(image.source));
    assert.equal(graph["6"].inputs.width, 1472); assert.equal(graph["6"].inputs.height, 1104);
    assert.equal(graph["1"].class_type, "UNETLoader"); assert.equal(graph["10"].class_type, "SaveImage");
    const downloaded = Buffer.from(await (await fetch(`${origin}${ready.previewUrl}`)).arrayBuffer());
    assert.deepEqual(await sharp(downloaded).raw().toBuffer(), await sharp(pixels).raw().toBuffer());
    await generate(image.id); ready = await completed(image.id);
    assert.equal(ready.imageGeneration!.reused, true); assert.equal(prompts.length, 1);
    await stop(); await start();
    await generate(image.id); await completed(image.id); assert.equal(prompts.length, 1);
    const outputPath = async () => {
      const data = JSON.parse(await readFile(path.join(directory, "resources/index.json"), "utf8"));
      return path.join(directory, "resources/previews", data.resources.find((item: Resource) => item.id === image.id).preview);
    };
    await rm(await outputPath()); await generate(image.id); await completed(image.id); assert.equal(prompts.length, 2);
    await writeFile(await outputPath(), "corrupted image"); await generate(image.id); await completed(image.id); assert.equal(prompts.length, 3);
    await request(`/api/resources/${image.id}`, { source: "Erreur du moteur" }, "PATCH");
    await generate(image.id); ready = await completed(image.id, "error");
    assert.equal(ready.previewUrl, undefined); assert.ok(ready.imageGeneration!.error);
    assert.equal((await fetch(`${origin}/api/resources/${image.id}/preview`)).status, 404);
    await request(`/api/resources/${image.id}`, { source: "Un autre tableau" }, "PATCH");
    await generate(image.id); await completed(image.id);
    const slow = await create("Longue génération", "Lent : un paysage");
    await generate(slow.id);
    for (let i = 0; i < 100 && !prompts.some(prompt => prompt.text.startsWith("Lent")); i++) await delay(10);
    const trackedId = prompts.find(prompt => prompt.text.startsWith("Lent"))!.id;
    assert.equal((await generate(slow.id)).status, 409);
    assert.equal((await request(`/api/resources/${slow.id}`, { source: "modification interdite" }, "PATCH")).status, 409);
    assert.equal((await request(`/api/resources/${slow.id}/generate-image/stop`)).status, 200);
    await completed(slow.id, "interrupted");
    assert.deepEqual(cancelled, [trackedId]); assert.deepEqual(forbidden, []);
    assert.equal((await get(image.id)).imageGeneration!.status, "done");
    await generate(slow.id);
    await stop(); await start();
    assert.equal((await get(slow.id)).imageGeneration!.status, "interrupted");
    assert.equal((await request(`/api/resources/${slow.id}/generate-image/stop`)).status, 409);
    assert.deepEqual(await readdir(path.join(directory, "work")), [], "generated work files are removed after copying into the resource");
  } finally {
    await stop(); comfy.closeAllConnections(); await new Promise<void>(resolve => comfy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
