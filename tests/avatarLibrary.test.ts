import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AvatarStore } from "../src/avatarStore.js";
import { BatchStore } from "../src/batchStore.js";

test("an avatar keeps its voice fingerprint and named generation history after restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "avatar-library-test-"));
  try {
    const store = new AvatarStore(path.join(directory, "projects"));
    await store.init();
    const project = await store.create("Ariane");
    const base = store.base(project);
    project.avatar = {
      name: "avatar.png", path: path.join(base, "avatar/avatar.png"), url: "", source: "uploaded"
    };
    project.voiceFingerprint = {
      name: "voice-fingerprint.wav", path: path.join(base, "voice/voice-fingerprint.wav"), url: "",
      duration: 8, refText: "Texte de reference", presetId: "narrator", voicePrompt: "Voix claire", createdAt: 10
    };
    project.generations = [{
      id: "generation-1", name: "Accueil", text: "Bienvenue", createdAt: 20, updatedAt: 30, status: "done",
      voice: {
        name: "speech-generation-1.wav", path: path.join(base, "voice/speech-generation-1.wav"), url: "",
        duration: 2, text: "Bienvenue", presetId: "narrator", voicePrompt: "Voix claire"
      },
      video: {
        name: "video-generation-1.mp4", path: path.join(base, "video/video-generation-1.mp4"), url: "",
        duration: 2, engine: "wan-s2v", continuity: "stable", stabilizationSeconds: 20
      }
    }];
    await store.save(project);

    const reloaded = new AvatarStore(path.join(directory, "projects"));
    await reloaded.init();
    const avatar = reloaded.get(project.id)!;
    assert.equal(avatar.voiceFingerprint?.refText, "Texte de reference");
    assert.equal(avatar.generations?.length, 1);
    assert.equal(avatar.generations?.[0].name, "Accueil");
    assert.match(avatar.generations?.[0].voice?.url || "", /speech-generation-1\.wav$/);
    assert.match(avatar.generations?.[0].video?.url || "", /video-generation-1\.mp4$/);
    assert.ok(path.isAbsolute(avatar.generations?.[0].video?.path || ""));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a running batch becomes safely resumable after a server restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "avatar-batch-test-"));
  try {
    const store = new BatchStore(directory);
    await store.init();
    const batch = await store.create({
      name: "Campagne",
      status: "running",
      currentIndex: 0,
      progress: 12,
      message: "Voix en cours",
      items: [{
        id: "item-1", avatarId: "avatar-1", avatarName: "Ariane", name: "Intro", text: "Bonjour",
        status: "voice", progress: 12, message: "Voix en cours"
      }],
      videoSettings: {
        quality: "normal", continuity: "stable", stabilizationSeconds: 20, sourceMode: "strict",
        framing: "original", motionPrompt: "", width: 768, height: 432, steps: 20, cfg: 6, seed: 123456
      }
    });

    const reloaded = new BatchStore(directory);
    await reloaded.init();
    const restored = reloaded.get(batch.id)!;
    assert.equal(restored.status, "stopped");
    assert.equal(restored.items[0].status, "stopped");
    assert.match(restored.message, /repris/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleting history preserves a shared fingerprint and archiving removes the avatar from the library", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "avatar-delete-test-"));
  try {
    const store = new AvatarStore(path.join(directory, "projects"));
    await store.init();
    const project = await store.create("Avatar supprimable");
    const base = store.base(project);
    const sharedVoice = path.join(base, "voice/shared.wav");
    const generationVideo = path.join(base, "video/generation.mp4");
    await writeFile(sharedVoice, "voice");
    await writeFile(generationVideo, "video");
    project.voiceFingerprint = {
      name: "shared.wav", path: sharedVoice, url: "", refText: "Reference", presetId: "narrator",
      voicePrompt: "Voix", createdAt: 1
    };
    project.generations = [{
      id: "generation-delete", name: "A supprimer", text: "Texte", createdAt: 2, updatedAt: 2, status: "done",
      voice: { name: "shared.wav", path: sharedVoice, url: "", text: "Texte", presetId: "narrator", voicePrompt: "Voix" },
      video: { name: "generation.mp4", path: generationVideo, url: "", engine: "wan-s2v" }
    }];
    await store.save(project);

    await store.removeGeneration(project, "generation-delete");
    assert.equal(project.generations?.length, 0);
    await access(sharedVoice);
    await assert.rejects(access(generationVideo));

    const archivedAt = await store.archive(project);
    assert.equal(store.get(project.id), undefined);
    await assert.rejects(access(base));
    await access(path.join(archivedAt, "project.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
