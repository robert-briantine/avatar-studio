import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { getCodeHighlighter } from "../src/codeHighlight.js";
import { MAX_RESOURCE_CODE_LENGTH, renderResourceCode, resourceCodeSvg } from "../src/resourceCode.js";
import { ResourceStore } from "../src/resourceStore.js";

test("TypeScript uses the same VS Code token colors in both themes and in the actual PNG pixels", async () => {
  const source = 'type Avatar = {\n\tname: string;\n};\n\nconst avatar: Avatar = { name: "Robert" };\n';
  const highlighter = await getCodeHighlighter();
  for (const [theme, background, keyword, type] of [
    ["dark-plus", "#1E1E1E", "#569CD6", "#4EC9B0"],
    ["light-plus", "#FFFFFF", "#0000FF", "#267F99"]
  ] as const) {
    const { tokens } = highlighter.codeToTokens(source, { lang: "typescript", theme });
    assert.equal(tokens[0].find(token => token.content === "type")!.color, keyword);
    assert.equal(tokens[0].find(token => token.content === "Avatar")!.color, type);
    const svg = await resourceCodeSvg(source, theme);
    assert.ok(svg.includes(`fill="${keyword}"`)); assert.ok(svg.includes(`fill="${type}"`));
    const { data, info } = await sharp(await renderResourceCode(source, theme)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1472); assert.equal(info.height, 1104);
    assert.equal(`#${data.subarray(0, 3).toString("hex")}`.toUpperCase(), background);
    const wanted = Buffer.from(keyword.slice(1), "hex");
    let colored = 0, minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    const bg = data.subarray(0, 3);
    for (let i = 0; i < data.length; i += 4) {
      if (data.subarray(i, i + 3).equals(wanted)) colored++;
      if (data.subarray(i, i + 3).equals(bg)) continue;
      const x = i / 4 % info.width, y = Math.floor(i / 4 / info.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    assert.ok(colored > 50, "the PNG must contain actual syntax colors");
    assert.ok(minX >= 60 && maxX < info.width - 60 && minY >= 60 && maxY < info.height - 60, "the rendered glyphs stay inside the frame");
  }
});

test("code rendering preserves indentation, blank and trailing lines, multiline tokens and escaped source", async () => {
  const tabbed = 'const avatar = {\n\tname: "Émilie",\n};\n';
  assert.equal(await resourceCodeSvg(tabbed), await resourceCodeSvg(tabbed.replace("\t", "    ")));
  assert.equal(await resourceCodeSvg(tabbed), await resourceCodeSvg(tabbed.replaceAll("\n", "\r\n")));
  assert.equal((await resourceCodeSvg("const x = 1;\n\n\n")).match(/<text /g)!.length, 4);
  const source = '/* début\n   commentaire */\nconst html = "<svg onload=\'alert(1)\'> & </svg>";';
  const svg = await resourceCodeSvg(source);
  assert.ok(svg.includes("&lt;svg")); assert.ok(svg.includes("&amp;"));
  assert.ok(!svg.includes("<svg onload"));
  const tokens = (await getCodeHighlighter()).codeToTokens(source, { lang: "typescript", theme: "dark-plus" }).tokens;
  assert.ok(tokens[1].every(token => token.color === "#6A9955"), "comments retain their grammar state across lines");
  assert.ok(svg.includes('fill="#6A9955"'));
  const dense = Array.from({ length: 40 }, (_, i) => `const valeur${i}: number = ${i};`).join("\n");
  const denseSvg = await resourceCodeSvg(dense);
  const size = Number(denseSvg.match(/font-size="([\d.]+)"/)![1]);
  assert.ok(size >= 14 && size < 32, "longer excerpts fit without cropping");
  await renderResourceCode(dense);
  for (const input of [undefined, null, 42, "", "  ", "x\u0000", "x".repeat(MAX_RESOURCE_CODE_LENGTH + 1), "x".repeat(200), "x\n".repeat(100), `const 日本語 = "${"漢".repeat(120)}";`]) {
    await assert.rejects(renderResourceCode(input), { status: 400 });
  }
  await assert.rejects(renderResourceCode("const x = 1;", "inconnu"), { status: 400 });
});

test("exact code sources and themes survive restart; failed renders and commits preserve the previous source and PNG", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resource-code-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const source = '\tconst prénom: string = "Émilie";  \r\n\r\nconsole.log(prénom);\r\n';
    const original = await store.create({ name: "MonCode", type: "typescript", source });
    assert.equal(original.source, source); assert.equal(original.codeTheme, "dark-plus"); assert.ok(original.preview);
    const before = await readFile(path.join(root, "index.json"), "utf8");
    const pixels = await readFile(store.previewPath(original.id)!);
    const files = await readdir(path.join(root, "previews"));
    await assert.rejects(store.update(original.id, { codeTheme: "absent" }), { status: 400 });
    await assert.rejects(store.update(original.id, { source: "x".repeat(200) }), { status: 400 });
    assert.deepEqual(store.get(original.id), original);
    assert.equal(await readFile(path.join(root, "index.json"), "utf8"), before);
    assert.deepEqual(await readdir(path.join(root, "previews")), files);
    const index = path.join(root, "index.json");
    await rename(index, `${index}.backup`); await mkdir(index);
    await assert.rejects(store.update(original.id, { codeTheme: "light-plus" }));
    assert.deepEqual(store.get(original.id), original);
    assert.deepEqual(await readdir(path.join(root, "previews")), files);
    await rm(index, { recursive: true }); await rename(`${index}.backup`, index);
    const updated = await store.update(original.id, { codeTheme: "light-plus" });
    assert.equal(updated.source, source); assert.notEqual(updated.preview, original.preview);
    assert.notDeepEqual(await readFile(store.previewPath(original.id)!), pixels);
    const restarted = new ResourceStore(root); await restarted.init(); assert.deepEqual(restarted.get(original.id), updated);
    // Stage 1 libraries without a theme remain readable, without rewriting their index on startup.
    const legacy = JSON.parse(await readFile(index, "utf8")); delete legacy.resources[0].codeTheme;
    await writeFile(index, JSON.stringify(legacy));
    const old = new ResourceStore(root); await old.init(); assert.equal(old.get(original.id)!.codeTheme, "dark-plus");
    assert.equal(old.get(original.id)!.source, source);
    const draft = await old.create({ name: "Brouillon", type: "typescript", source: "", codeTheme: "light-plus" });
    assert.equal(draft.preview, undefined); assert.equal(draft.codeTheme, "light-plus");
    await old.update(original.id, { source: "" }); assert.equal(old.get(original.id)!.preview, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
