import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { parseAvatarScript } from "../src/avatarScript.js";
import { ResourceStore } from "../src/resourceStore.js";
import { diagramFromText } from "../src/diagramModel.js";
import { bindScriptReferences, prepareScriptReferenceImage, resolveScriptReferences } from "../src/scriptReferences.js";

const png = (color: string) => sharp({ create: { width: 400, height: 300, channels: 4, background: color } }).png().toBuffer();
async function image(store: ResourceStore, name: string, color = "#308a76") {
  const resource = await store.create({ name, type: "image", source: "Une image enregistrée." });
  const job = await store.beginImageGeneration(resource.id);
  return store.finishImageGeneration(resource.id, job.imageGeneration!.id, await png(color));
}

test("all named resource types resolve to saved pixels and keep stable bindings after rename and restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "script-references-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const background = await image(store, "Café");
    const formula = await store.create({ name: "Énergie", type: "latex", source: "E = mc^2", backgroundImageId: background.id });
    const code = await store.create({ name: "Code", type: "typescript", source: 'const message: string = "Bonjour";\n', backgroundImageId: background.id });
    const diagram = await store.create({ name: "Schéma", type: "diagram", source: JSON.stringify(diagramFromText("Texte → Voix → Vidéo")),
      diagramPreview: `data:image/png;base64,${(await png("#ef8040")).toString("base64")}`, backgroundImageId: background.id });
    const script = parseAvatarScript("{Ref:CAFÉ} Image. {Ref:Cafe\u0301} Même image. {Ref:Énergie} Formule. {Ref:Code} Code. {Ref:Schéma} Diagramme.");
    const references = await resolveScriptReferences(script, store);
    assert.equal(references.size, 5);
    assert.equal(references.get("CAFÉ")!.resourceId, background.id);
    assert.equal(references.get("Cafe\u0301")!.path, references.get("CAFÉ")!.path);
    for (const [name, resource] of [["Énergie", formula], ["Code", code], ["Schéma", diagram]] as const) {
      assert.equal(references.get(name)!.resourceId, resource.id);
      assert.deepEqual(await readFile(references.get(name)!.path), await readFile(store.previewPath(resource.id)!));
    }
    const bindings = bindScriptReferences(references)!;
    assert.equal(bindings[0].name, "CAFÉ"); assert.equal(bindings[0].resourceId, background.id);
    await store.update(background.id, { name: "Fond renommé" });
    const restarted = new ResourceStore(root); await restarted.init();
    const renamed = await resolveScriptReferences(script, restarted, bindings);
    assert.equal(renamed.get("CAFÉ")!.name, "Fond renommé");
    assert.equal(renamed.get("CAFÉ")!.resourceId, background.id);
    await assert.rejects(resolveScriptReferences(script, restarted), /CAFÉ.*introuvable/);
    assert.equal((await resolveScriptReferences(parseAvatarScript("{Ref:Fond renommé} Bonjour."), restarted)).size, 1);
    assert.equal((await resolveScriptReferences(parseAvatarScript("Bonjour."), restarted)).size, 0);
    await assert.rejects(resolveScriptReferences(script, restarted, []), /associations/);
    await assert.rejects(resolveScriptReferences(script, restarted, [{ name: "CAFÉ", resourceId: "../../escape" }]), /associations/);
    await assert.rejects(resolveScriptReferences(script, restarted, bindings, AbortSignal.abort()), { name: "AbortError" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown names, drafts, legacy diagrams, corrupt PNGs and missing composition backgrounds fail before rendering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "script-reference-errors-"));
  try {
    const store = new ResourceStore(root); await store.init();
    await assert.rejects(resolveScriptReferences(parseAvatarScript("{Ref:Introuvable} Bonjour."), store), /Introuvable.*introuvable/);
    for (const type of ["image", "latex", "typescript", "diagram"] as const) {
      const resource = await store.create({ name: `Brouillon-${type}`, type });
      await assert.rejects(resolveScriptReferences(parseAvatarScript(`{Ref:${resource.name}} Bonjour.`), store), /indisponible/);
    }
    await store.create({ name: "Ancien diagramme", type: "diagram", source: "Entrée → Sortie" });
    await assert.rejects(resolveScriptReferences(parseAvatarScript("{Ref:Ancien diagramme} Bonjour."), store), /Apollon/);
    const background = await image(store, "Fond requis");
    const formula = await store.create({ name: "Formule", type: "latex", source: "x+1", backgroundImageId: background.id });
    const file = store.previewPath(background.id)!; const pixels = await readFile(file);
    await writeFile(file, "corrompu");
    await assert.rejects(resolveScriptReferences(parseAvatarScript("{Ref:Fond requis} Image."), store), /absent ou illisible/);
    await assert.rejects(resolveScriptReferences(parseAvatarScript("{Ref:Formule} Formule."), store), /Fond requis.*absente ou illisible/);
    await rm(file);
    await assert.rejects(resolveScriptReferences(parseAvatarScript("{Ref:Formule} Formule."), store), /Fond requis/);
    await writeFile(file, pixels);
    const restored = await resolveScriptReferences(parseAvatarScript("{Ref:Formule} Formule."), store);
    assert.equal(restored.get("Formule")!.resourceId, formula.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transparent formula references remain legible on a white video canvas without changing the saved PNG", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "script-reference-canvas-"));
  try {
    const store = new ResourceStore(root); await store.init();
    const formula = await store.create({ name: "Formule seule", type: "latex", source: String.raw`\frac{x+1}{y}` });
    const input = store.previewPath(formula.id)!; const original = await readFile(input);
    const output = path.join(root, "canvas.png");
    await prepareScriptReferenceImage(input, output, 320, 240);
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 320); assert.equal(info.height, 240); assert.deepEqual([...data.subarray(0, 4)], [255, 255, 255, 255]);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) { assert.equal(data[i + 3], 255); if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) ink++; }
    assert.ok(ink > 100); assert.deepEqual(await readFile(input), original);
    await assert.rejects(prepareScriptReferenceImage(input, output, 320, 240, AbortSignal.abort()), { name: "AbortError" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
