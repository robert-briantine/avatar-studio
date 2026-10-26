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

test("TypeScript preview API and saves share a PNG renderer, persist the theme and retain the previous version on failure", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "resource-code-api-"));
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
    const source = 'type Avatar = {\r\n\tname: string;  \r\n};\r\n\r\nconst avatar: Avatar = { name: "Robert" };\r\n';
    const body = { source, codeTheme: "light-plus" };
    const preview = await request("/api/resources/typescript/preview", body);
    assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
    const live = await preview.json(); assert.equal(live.width, 1472); assert.equal(live.height, 1104);
    const pixels = Buffer.from(live.image.split(",")[1], "base64");
    assert.equal((await sharp(pixels).metadata()).format, "png");
    assert.deepEqual((await (await fetch(`${origin}/api/resources`)).json()).resources, []);
    for (const body of [{ source: "" }, { source: 42 }, { source: "const x = 1;", codeTheme: "unknown" }, { source: "x".repeat(200) }]) {
      const response = await request("/api/resources/typescript/preview", body); assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    const create = await request("/api/resources", { name: "MonCode", type: "typescript", ...body }); assert.equal(create.status, 201);
    const resource = (await create.json()).resource;
    assert.equal(resource.source, source); assert.equal(resource.codeTheme, "light-plus"); assert.ok(resource.previewUrl);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${resource.previewUrl}`)).arrayBuffer()), pixels, "saved and live visuals are identical");
    const summary = (await (await fetch(`${origin}/api/resources`)).json()).resources[0];
    assert.equal(summary.codeTheme, "light-plus"); assert.equal(summary.source, undefined);
    const index = await readFile(path.join(directory, "resources/index.json"), "utf8");
    const invalid = await request(`/api/resources/${resource.id}`, { source: "x\n".repeat(100) }, "PATCH");
    assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /visuel lisible/);
    assert.equal(await readFile(path.join(directory, "resources/index.json"), "utf8"), index);
    assert.deepEqual((await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource, resource);
    const themed = await request(`/api/resources/${resource.id}`, { codeTheme: "dark-plus" }, "PATCH");
    assert.equal(themed.status, 200); const updated = (await themed.json()).resource;
    assert.equal(updated.source, source); assert.equal(updated.codeTheme, "dark-plus");
    assert.notDeepEqual(Buffer.from(await (await fetch(`${origin}${updated.previewUrl}`)).arrayBuffer()), pixels);
    await stop(); await start();
    assert.deepEqual((await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource, updated);
    assert.equal((await fetch(`${origin}${updated.previewUrl}`)).status, 200);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
