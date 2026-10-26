import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { ResourceStore } from "../src/resourceStore.js";
import { DEFAULT_RESOURCE_LATEX_COLOR, MAX_RESOURCE_LATEX_LENGTH, renderResourceLatex, renderResourceLatexPreview, resourceLatexColor } from "../src/latex.js";
import { latexInsertion } from "../public/resourceLatex.js";

test("formula resources render real math on transparent centered images and fitted live previews", async () => {
  for (const source of ["E = mc^{2}", String.raw`\frac{x_{1}+1}{\sqrt{y}} + \sum_{n=1}^{\infty} n^{-2}`,
    String.raw`\begin{aligned}x &= 1 \\ y &= 2\end{aligned}`]) {
    const image = await renderResourceLatex(source);
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1472); assert.equal(info.height, 1104); assert.equal(info.channels, 4);
    let visible = 0;
    let minY = info.height, maxY = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      visible++;
      const y = Math.floor(i / 4 / info.width); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    assert.ok(visible > 100);
    assert.ok(Math.abs((minY + maxY) / 2 - info.height / 2) < info.height * 0.1, "the resource formula must be centered");
    assert.equal(data[3], 0, "the image background is transparent");
    const preview = await sharp(await renderResourceLatexPreview(source)).metadata();
    assert.ok(preview.width! <= 1200 && preview.height! <= 320);
    assert.ok(preview.width! > 10 && preview.height! > 10);
  }
  assert.notDeepEqual(await renderResourceLatexPreview("xy"), await renderResourceLatexPreview(String.raw`\frac{x}{y}`));
});

test("LaTeX syntax errors explain braces, unknown commands and missing arguments in French", async () => {
  for (const [source, message] of [
    [String.raw`\frac{x}{y`, /Il manque une accolade/], ["x}", /accolade.*en trop/],
    [String.raw`\inconnue{x}`, /Commande inconnue.*\\inconnue/], [String.raw`\sqrt`, /attend un contenu/],
    [String.raw`\left(x`, /doit être fermé/]
  ] as const) await assert.rejects(renderResourceLatexPreview(source), message);
  for (const source of [undefined, null, 123, "", "   ", "x".repeat(MAX_RESOURCE_LATEX_LENGTH + 1)]) {
    await assert.rejects(renderResourceLatexPreview(source), { status: 400 });
  }
  await renderResourceLatexPreview(String.raw`\newcommand{\locale}{x}\locale`);
  await assert.rejects(renderResourceLatexPreview(String.raw`\locale`), /Commande inconnue/);
  await assert.rejects(renderResourceLatexPreview(String.raw`\require{html}`), /Commande inconnue/);
  await assert.rejects(renderResourceLatexPreview(String.raw`\href{https://example.com}{x}`), /Commande inconnue/);
});

test("formula colors apply to previews and saved PNGs while retaining transparent backgrounds", async () => {
  assert.equal(resourceLatexColor(undefined), DEFAULT_RESOURCE_LATEX_COLOR);
  assert.equal(resourceLatexColor("#Ab12EF"), "#ab12ef");
  for (const color of ["#e83050", "#ffffff", "#000000"]) {
    const expected = color.slice(1).match(/../g)!.map(channel => parseInt(channel, 16));
    for (const render of [renderResourceLatexPreview, renderResourceLatex]) {
      const { data, info } = await sharp(await render(String.raw`\frac{x+1}{y^2}`, color)).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.channels, 4);
      let opaque = 0, transparent = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (!data[i + 3]) transparent++;
        if (data[i + 3] === 255) {
          assert.deepEqual([...data.subarray(i, i + 3)], expected);
          opaque++;
        }
      }
      assert.ok(opaque > 100 && transparent > 100, "glyphs use the selected color on a transparent canvas");
    }
  }
  for (const color of [null, 42, "", "red", "#fff", "#12345678", '#fff\" onload=\"alert(1)']) {
    assert.throws(() => resourceLatexColor(color), { status: 400 });
    await assert.rejects(renderResourceLatexPreview("x", color), { status: 400 });
    await assert.rejects(renderResourceLatex("x", color), { status: 400 });
  }
});

test("changing only the formula color regenerates its PNG and persists across renaming and restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resource-latex-color-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const original = await store.create({ name: "Formule colorée", type: "latex", source: "E=mc^2" });
    assert.equal(original.latexColor, DEFAULT_RESOURCE_LATEX_COLOR);
    const oldPng = await readFile(store.previewPath(original.id)!);
    const colored = await store.update(original.id, { latexColor: "#E83050" });
    assert.equal(colored.source, original.source); assert.equal(colored.latexColor, "#e83050");
    assert.notEqual(colored.preview, original.preview);
    const png = await readFile(store.previewPath(original.id)!);
    assert.notDeepEqual(png, oldPng);
    assert.deepEqual(png, await renderResourceLatex(original.source, colored.latexColor));
    const renamed = await store.update(original.id, { name: "Formule renommée" });
    assert.equal(renamed.latexColor, colored.latexColor);
    const restarted = new ResourceStore(root); await restarted.init();
    assert.deepEqual(restarted.get(original.id), renamed);
    const index = await readFile(path.join(root, "index.json"), "utf8");
    await assert.rejects(restarted.update(original.id, { latexColor: "bad" }), { status: 400 });
    await assert.rejects(restarted.create({ name: "Brouillon invalide", type: "latex", latexColor: null }), { status: 400 });
    assert.equal(await readFile(path.join(root, "index.json"), "utf8"), index);
    assert.deepEqual(await readFile(restarted.previewPath(original.id)!), png);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("formula sources and PNGs survive restart; invalid edits and failed publication preserve the saved formula", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resource-latex-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const source = "  \\frac{x_{1}}{y^{2}} + \\alpha\n";
    const resource = await store.create({ name: "Formule", type: "latex", source });
    assert.equal(resource.source, source); assert.ok(resource.preview);
    const file = store.previewPath(resource.id)!;
    const pixels = await readFile(file);
    const before = await readFile(path.join(root, "index.json"), "utf8");
    const files = await readdir(path.join(root, "previews"));
    await assert.rejects(store.update(resource.id, { source: String.raw`\frac{x}` }), { status: 400 });
    await assert.rejects(store.create({ name: "Invalide", type: "latex", source: String.raw`\inconnue` }), { status: 400 });
    assert.deepEqual(store.get(resource.id), resource);
    assert.equal(await readFile(path.join(root, "index.json"), "utf8"), before);
    assert.deepEqual(await readFile(file), pixels);
    assert.deepEqual(await readdir(path.join(root, "previews")), files);
    const index = path.join(root, "index.json");
    await rename(index, `${index}.backup`); await mkdir(index);
    await assert.rejects(store.update(resource.id, { source: "E = mc^{2}" }));
    assert.deepEqual(store.get(resource.id), resource);
    assert.deepEqual(await readdir(path.join(root, "previews")), files, "failed disk commits clean their unpublished PNG");
    await rm(index, { recursive: true }); await rename(`${index}.backup`, index);
    const restarted = new ResourceStore(root); await restarted.init();
    assert.equal(restarted.get(resource.id)!.source, source);
    assert.deepEqual(await readFile(restarted.previewPath(resource.id)!), pixels);
    await restarted.update(resource.id, { source: "E = mc^{2}" });
    assert.notDeepEqual(await readFile(restarted.previewPath(resource.id)!), pixels);
    const draft = await restarted.create({ name: "Brouillon", type: "latex", source: "" });
    assert.equal(draft.preview, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("LaTeX insertion tools wrap selections and select the next editable placeholder", () => {
  for (const [kind, selected, content, text, placeholder] of [
    ["fraction", "", false, String.raw`\frac{a}{b}`, "a"],
    ["fraction", "x+1", true, String.raw`\frac{x+1}{b}`, "b"],
    ["power", "", true, "^{2}", "2"], ["power", "x+1", true, "{x+1}^{2}", "2"],
    ["subscript", "", false, "x_{1}", "1"], ["sqrt", "", false, String.raw`\sqrt{x}`, "x"],
    ["sum", "", false, String.raw`\sum_{n=1}^{N}`, "N"]
  ] as const) {
    const insertion = latexInsertion(kind, selected, content);
    assert.equal(insertion.text, text);
    assert.equal(text.slice(insertion.start, insertion.end), placeholder);
  }
  for (const kind of ["alpha", "beta", "pi", "infinity"]) {
    const insertion = latexInsertion(kind);
    assert.equal(insertion.start, insertion.text.length); assert.equal(insertion.end, insertion.text.length);
    assert.ok(insertion.text.endsWith(" "), "symbol commands must not merge with subsequent letters");
  }
});
