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
import { WAN_S2V_STABILIZATION_SECONDS } from "../src/wanS2V.js";

test("video API is Wan Extend only and regenerations create a new history entry", { timeout: 15_000 }, async () => {
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
    project.generations = [{
      id: "previous", name: "Version initiale", text: "Bonjour", createdAt: Date.now(), updatedAt: Date.now(),
      status: "done", voice: project.voice, video: project.video
    }];
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
    const invalidResponse = await generate({ generationId: "previous", transitionStyle: "unknown" });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await getProject()).generations?.length, 1, "an invalid transition must not create a new history revision");
    const firstResponse = await generate({ generationId: "previous", stabilizationSeconds: 120 });
    assert.equal(firstResponse.status, 202);
    const created = await firstResponse.json() as { generation: { id: string; name: string }; project: AvatarProject };
    assert.notEqual(created.generation.id, "previous");
    assert.equal(created.generation.name, "Version initiale — vidéo 2");
    assert.equal(created.project.generations?.length, 2);
    assert.equal(created.project.generations?.[1].video?.name, "existing.mp4");
    assert.equal(created.project.generations?.[0].voice?.name, "voice.wav");
    const saved = await waitForFailure();
    assert.deepEqual(saved.videoSettings, { engine: "wan-s2v", upscale: false, continuity: "continuous" });
    assert.equal(saved.generations?.[0].videoSettings?.transitionStyle, undefined);
    assert.equal(saved.video?.name, "existing.mp4");
    assert.equal(saved.video?.continuity, "continuous");

    await stop();
    await start();
    assert.deepEqual((await getProject()).videoSettings, saved.videoSettings);
    assert.equal((await getProject()).generations?.[0].videoSettings?.transitionStyle, undefined);
    const finalAttempt = await generate({
      generationId: created.generation.id, quality: "final", steps: 32, continuity: "stable", stabilizationSeconds: 9, transitionStyle: "interpolated"
    });
    assert.equal(finalAttempt.status, 202);
    const finalProject = (await finalAttempt.json() as { project: AvatarProject }).project;
    const finalGeneration = finalProject.generations?.find(item => item.id === created.generation.id);
    assert.deepEqual({
      quality: finalGeneration?.videoSettings?.quality,
      width: finalGeneration?.videoSettings?.width,
      height: finalGeneration?.videoSettings?.height,
      steps: finalGeneration?.videoSettings?.steps,
      cfg: finalGeneration?.videoSettings?.cfg
    }, { quality: "final", width: 832, height: 480, steps: 32, cfg: 6 });
    const continuousOnly = await waitForFailure();
    assert.deepEqual(continuousOnly.videoSettings, { engine: "wan-s2v", upscale: false, continuity: "continuous" });
    assert.equal((await generate({ engine: "hybrid" })).status, 400);
  } finally {
    await stop();
    comfy.closeAllConnections();
    await new Promise<void>(resolve => comfy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
