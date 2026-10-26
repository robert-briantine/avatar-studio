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
import { renderResourceLatex, renderResourceLatexPreview } from "../src/latex.js";

test("LaTeX preview API renders without saving and formula saves validate and persist the exact editable source", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "resource-latex-api-"));
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
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/api/resources`)).ok) return; } catch {} await delay(25); }
    assert.fail(`Server did not start: ${output}`);
  };
  const stop = async () => {
    if (app && app.exitCode === null && app.signalCode === null) { const closed = once(app, "close"); app.kill("SIGTERM"); await closed; }
  };
  try {
    await start();
    const request = (url: string, body: unknown, method = "POST") => fetch(`${origin}${url}`, { method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const latexColor = "#e83050";
    const preview = await request("/api/resources/latex/preview", { source: String.raw`\frac{x+1}{y}`, latexColor });
    assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
    const live = await preview.json(); assert.ok(live.image.startsWith("data:image/png;base64,"));
    assert.ok(live.width > 0 && live.height > 0);
    assert.equal((await sharp(Buffer.from(live.image.split(",")[1], "base64")).metadata()).format, "png");
    assert.deepEqual(Buffer.from(live.image.split(",")[1], "base64"), await renderResourceLatexPreview(String.raw`\frac{x+1}{y}`, latexColor));
    assert.deepEqual((await (await fetch(`${origin}/api/resources`)).json()).resources, [], "live previews do not create resources");
    for (const source of ["", String.raw`\frac{x}`, String.raw`\unknown`, 42]) {
      const response = await request("/api/resources/latex/preview", { source }); assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    for (const latexColor of ["bad", "#fff", null, 42]) {
      assert.equal((await request("/api/resources/latex/preview", { source: "x", latexColor })).status, 400);
    }
    const source = "  \\frac{x}{y} + \\alpha\n";
    const create = await request("/api/resources", { name: "MaFormule", type: "latex", source, latexColor });
    assert.equal(create.status, 201);
    let resource = (await create.json()).resource; assert.equal(resource.source, source); assert.ok(resource.previewUrl);
    assert.equal(resource.latexColor, latexColor);
    const rendered = await fetch(`${origin}${resource.previewUrl}`); assert.equal(rendered.status, 200);
    const png = Buffer.from(await rendered.arrayBuffer());
    assert.deepEqual(png, await renderResourceLatex(source, latexColor));
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 1472); assert.equal(metadata.height, 1104); assert.equal(metadata.hasAlpha, true);
    const index = await readFile(path.join(directory, "resources/index.json"), "utf8");
    const invalid = await request(`/api/resources/${resource.id}`, { source: String.raw`\frac{x}{y` }, "PATCH");
    assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /Il manque une accolade/);
    assert.equal(await readFile(path.join(directory, "resources/index.json"), "utf8"), index);
    const reopened = (await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource;
    assert.deepEqual(reopened, resource);
    const recolored = await request(`/api/resources/${resource.id}`, { latexColor: "#FFFFFF" }, "PATCH");
    assert.equal(recolored.status, 200); resource = (await recolored.json()).resource;
    assert.equal(resource.latexColor, "#ffffff"); assert.equal(resource.source, source);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${resource.previewUrl}`)).arrayBuffer()), await renderResourceLatex(source, "#ffffff"));
    await stop(); await start();
    assert.deepEqual((await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource, resource);
    assert.equal((await fetch(`${origin}${resource.previewUrl}`)).status, 200);
    const draft = await request("/api/resources", { name: "Brouillon", type: "latex", source: "" });
    assert.equal(draft.status, 201); assert.equal((await draft.json()).resource.previewUrl, undefined);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
