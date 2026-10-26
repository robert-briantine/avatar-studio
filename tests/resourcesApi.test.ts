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
import { ResourceStore, type Resource } from "../src/resourceStore.js";

test("shared resource API creates, edits, reopens and persists all types without requiring an avatar", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "resource-api-"));
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  let origin: string;
  const start = async () => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory, TTS_URL: "http://127.0.0.1:1", COMFY_URL: "http://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout!.on("data", bytes => { output += bytes; });
    child.stderr!.on("data", bytes => { output += bytes; });
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${origin}/api/resources`)).ok) return; } catch {}
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.fail(`Resource server did not start: ${output}`);
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  };
  try {
    const store = new ResourceStore(path.join(directory, "resources"));
    await store.init();
    const rendered = await store.create({ name: "Aperçu existant", type: "image", source: "image déjà rendue" });
    const file = path.join(directory, "resources/index.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.resources[0].preview = `${rendered.id}.png`;
    await writeFile(file, JSON.stringify(stored));
    await sharp({ create: { width: 32, height: 24, channels: 3, background: "green" } }).png()
      .toFile(path.join(directory, "resources/previews", `${rendered.id}.png`));
    await start();
    const request = (route: string, body: unknown, method = "POST") => fetch(`${origin}${route}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const list = async () => (await (await fetch(`${origin}/api/resources`)).json());
    const initial = await list();
    assert.equal(initial.scope, "shared");
    assert.deepEqual(initial.types.map((type: { id: string }) => type.id), ["image", "latex", "typescript", "diagram"]);
    const preview = await fetch(`${origin}${initial.resources[0].previewUrl}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type")!, /image\/png/);
    assert.equal((await fetch(`${origin}/api/resources/absent`)).status, 404);
    assert.equal((await fetch(`${origin}/api/resources/absent/preview`)).status, 404);
    const created: Resource[] = [];
    for (const [type, source] of [["image", "  Fond du cours\n"], ["latex", "\\frac{x}{y}"],
      ["typescript", "\tconst titre: string = 'Bonjour';\n"], ["diagram", '{"nodes": []}']]) {
      const response = await request("/api/resources", { name: `Exemple-${type}`, type, source,
        ...(type === "image" ? {} : { backgroundImageId: rendered.id }) });
      assert.equal(response.status, 201);
      const { resource } = await response.json();
      assert.equal(resource.source, source);
      const reopened = (await (await fetch(`${origin}/api/resources/${resource.id}`)).json()).resource;
      assert.deepEqual(reopened, resource);
      created.push(resource);
    }
    const beforeErrors = await list();
    assert.ok(beforeErrors.resources.every((resource: Resource) => !("source" in resource)), "list summaries omit potentially large source text");
    for (const body of [{ name: " ", type: "image" }, { name: "Invalid", type: "other" },
      { name: "Wrong background", type: "latex", backgroundImageId: created[1].id }]) {
      const response = await request("/api/resources", body);
      assert.equal(response.status, 400);
      assert.ok((await response.json()).error);
    }
    assert.equal((await request("/api/resources", { name: "EXEMPLE-IMAGE", type: "diagram" })).status, 409);
    assert.equal((await request(`/api/resources/${created[1].id}`, { name: "Exemple-image" }, "PATCH")).status, 409);
    assert.deepEqual(await list(), beforeErrors);
    assert.equal((await request("/api/resources/absent", { source: "test" }, "PATCH")).status, 404);
    const edit = await request(`/api/resources/${created[2].id}`, { name: "CodeRenommé", source: "\n  const nombre = 42;\n" }, "PATCH");
    assert.equal(edit.status, 200);
    const { resource: edited } = await edit.json();
    assert.equal(edited.id, created[2].id);
    assert.equal(edited.source, "\n  const nombre = 42;\n");
    assert.equal((await request(`/api/resources/${rendered.id}`, { source: "nouvelle description" }, "PATCH")).status, 200);
    assert.equal((await fetch(`${origin}/api/resources/${rendered.id}/preview`)).status, 404, "an obsolete preview is not exposed after editing its source");
    for (const name of ["Avatar A", "Avatar B"]) assert.equal((await request("/api/project", { name })).status, 200);
    const expected = await list();
    await stop();
    await start();
    assert.deepEqual(await list(), expected);
    const reopened = (await (await fetch(`${origin}/api/resources/${edited.id}`)).json()).resource;
    assert.deepEqual(reopened, edited);
    assert.equal(reopened.backgroundImageId, rendered.id);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
