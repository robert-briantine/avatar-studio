import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AvatarStore, type AvatarProject } from "../src/avatarStore.js";

test("video API validates and remembers stabilization settings without touching an existing video", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wan-settings-test-"));
  // No models or GPU are contacted. The detached job deliberately fails its
  // preflight, so settings must also survive a failed attempt and an app restart.
  const comfy = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  comfy.listen(0, "127.0.0.1");
  await once(comfy, "listening");
  const comfyPort = (comfy.address() as { port: number }).port;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  const start = async () => {
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory,
        COMFY_URL: `http://127.0.0.1:${comfyPort}`, TTS_URL: `http://127.0.0.1:${comfyPort}` },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout!.on("data", bytes => { output += bytes; });
    child.stderr!.on("data", bytes => { output += bytes; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/api/projects`)).ok) return; } catch {}
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.fail(`Test server did not start: ${output}`);
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  };
  try {
    const store = new AvatarStore(path.join(directory, "projects"));
    await store.init();
    const project = await store.create("Test stabilisation");
    const base = store.base(project);
    project.avatar = { name: "avatar.png", path: path.join(base, "avatar/avatar.png"), url: "", source: "uploaded" };
    project.voice = { name: "voice.wav", path: path.join(base, "voice/voice.wav"), url: "", duration: 122.18, text: "", presetId: "", voicePrompt: "" };
    project.video = { name: "existing.mp4", path: path.join(base, "video/existing.mp4"), url: "", engine: "wan-s2v", continuity: "continuous" };
    await store.save(project);
    await start();
    const getProject = async (): Promise<AvatarProject> => (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
    const generate = (body: Record<string, unknown>) => fetch(`${origin}/api/video/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, ...body })
    });
    const waitForFailure = async () => {
      for (let i = 0; i < 100; i++) {
        const current = await getProject();
        if (current.currentJob?.status === "error") {
          assert.match(current.currentJob.error!, /ComfyUI manquant/);
          return current;
        }
        await delay(25);
      }
      assert.fail(`Detached preflight did not finish: ${output}`);
    };
    for (const stabilizationSeconds of [0, -1, 121, "", null, "invalid"]) {
      const response = await generate({ continuity: "stable", stabilizationSeconds });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /entre 1 et 120/);
    }
    assert.equal((await getProject()).currentJob, undefined, "invalid input must not create a job");
    assert.equal((await getProject()).videoSettings, undefined);

    assert.equal((await generate({ continuity: "stable" })).status, 202);
    assert.deepEqual((await waitForFailure()).videoSettings, { continuity: "stable", stabilizationSeconds: 20 });
    assert.equal((await generate({ continuity: "stable", stabilizationSeconds: 12.5 })).status, 202);
    const saved = await waitForFailure();
    assert.deepEqual(saved.videoSettings, { continuity: "stable", stabilizationSeconds: 12.5 });
    assert.equal(saved.video?.name, "existing.mp4");
    assert.equal(saved.video?.continuity, "continuous");

    await stop();
    await start();
    assert.deepEqual((await getProject()).videoSettings, saved.videoSettings);
    assert.equal((await generate({ continuity: "continuous", stabilizationSeconds: "ignored" })).status, 202);
    assert.deepEqual((await waitForFailure()).videoSettings, { continuity: "continuous", stabilizationSeconds: 12.5 });
    assert.equal((await generate({ continuity: "stable" })).status, 202);
    assert.deepEqual((await waitForFailure()).videoSettings, saved.videoSettings);
  } finally {
    await stop();
    comfy.closeAllConnections();
    await new Promise<void>(resolve => comfy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
