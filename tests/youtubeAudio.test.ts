import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractYouTubeVoice, parseAudioTimestamp, parseYouTubeUrl } from "../src/youtubeAudio.js";

const exec = promisify(execFile);
const id = "BaW_jenozKc";

test("YouTube URLs normalize video links and reject other hosts, playlists and credentials", () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&list=abc&t=90`, `https://youtu.be/${id}?t=90`,
    `https://m.youtube.com/watch?v=${id}`, `www.youtube.com/shorts/${id}`, `https://youtube.com/embed/${id}`,
    `https://youtube.com/live/${id}`
  ]) assert.equal(parseYouTubeUrl(url), `https://www.youtube.com/watch?v=${id}`);
  for (const url of ["", undefined, `https://youtube.com.evil.test/watch?v=${id}`, `https://evil.test/${id}`,
    `https://youtube.com@localhost/watch?v=${id}`, `https://user:password@youtube.com/watch?v=${id}`,
    `https://youtube.com:8443/watch?v=${id}`, "file:///etc/passwd", "--exec=bad", "https://youtube.com/playlist?list=test",
    "https://youtube.com/@channel", "https://youtube.com/watch?v=short"]) assert.throws(() => parseYouTubeUrl(url));
});

test("audio timestamps accept seconds, minutes and hours and reject invalid offsets", () => {
  for (const [input, expected] of [[0, 0], [90, 90], ["01:30", 90], ["1:02:03.125", 3723.125],
    ["90,5", 90.5], ["120:00", 7200], [" 00:00 ", 0]] as const) assert.equal(parseAudioTimestamp(input), expected);
  for (const input of [undefined, null, true, "", "-1", -1, "1:60", "1:60:00", "1::2", "NaN", Infinity,
    "00:00:00:00", "0.0015", "1e8", "99999999999999999999", "2;echo test"]) assert.throws(() => parseAudioTimestamp(input));
});

test("YouTube extraction seeks to the requested sample, returns exactly three seconds and rejects incomplete clips", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "youtube-audio-"));
  const oldTool = process.env.YT_DLP_PATH;
  const rate = 24000;
  const wav = Buffer.alloc(44 + 9 * rate * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 9 * rate; i++) {
    const frequency = i < 3 * rate ? 220 : i < 6 * rate ? 880 : 1320;
    wav.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  }
  const source = createServer((req, res) => {
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    res.writeHead(range ? 206 : 200, { "content-type": "audio/wav", "accept-ranges": "bytes",
      "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${wav.length}` } : {}) });
    res.end(wav.subarray(start, end + 1));
  });
  try {
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    const metadataFile = path.join(directory, "metadata.json");
    const metadata = { title: "Extrait test", duration: 9,
      url: `http://127.0.0.1:${(source.address() as { port: number }).port}/audio.wav`, http_headers: { "User-Agent": "test" } };
    await writeFile(metadataFile, JSON.stringify(metadata));
    const tool = path.join(directory, "fake-yt-dlp");
    await writeFile(tool, `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(metadataFile)},'utf8'));\n`, { mode: 0o755 });
    process.env.YT_DLP_PATH = tool;
    const output = path.join(directory, "clip.wav");
    const start = 4.125;
    assert.deepEqual(await extractYouTubeVoice(`https://youtu.be/${id}`, start, output), { duration: 3, title: "Extrait test" });
    const { stdout: pcm } = await exec("ffmpeg", ["-v", "error", "-i", output, "-f", "s16le", "pipe:1"], { encoding: "buffer" });
    assert.deepEqual(pcm, wav.subarray(44 + start * rate * 2, 44 + (start + 3) * rate * 2),
      "decoded output must contain exactly the requested audio samples, without padding or a shifted start");
    await assert.rejects(extractYouTubeVoice(`https://youtu.be/${id}`, 7, output), /début plus tôt/);
    await writeFile(metadataFile, JSON.stringify({ ...metadata, is_live: true }));
    await assert.rejects(extractYouTubeVoice(`https://youtu.be/${id}`, 0, output), /direct/);
    await writeFile(metadataFile, JSON.stringify({ ...metadata, url: "file:///etc/passwd" }));
    await assert.rejects(extractYouTubeVoice(`https://youtu.be/${id}`, 0, output), /piste audio/);
    await writeFile(metadataFile, JSON.stringify({ ...metadata, duration: 99 }));
    await assert.rejects(extractYouTubeVoice(`https://youtu.be/${id}`, 8, output), /incomplet/);
    await assert.rejects(extractYouTubeVoice(`https://youtu.be/${id}`, 0, output, AbortSignal.abort()), { name: "AbortError" });
    process.env.YT_DLP_PATH = path.join(directory, "missing-tool");
    await assert.rejects(extractYouTubeVoice(`https://youtu.be/${id}`, 0, output), /install-youtube-audio.sh/);
  } finally {
    if (oldTool === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = oldTool;
    source.closeAllConnections();
    await new Promise<void>(resolve => source.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
