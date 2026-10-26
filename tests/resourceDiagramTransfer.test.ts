import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { diagramFromText, emptyDiagram } from "../src/diagramModel.js";
import { resourceDiagramModel } from "../src/resourceDiagram.js";

const script = await readFile(new URL("../public/resourceDiagram.js", import.meta.url), "utf8");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function editorHarness(initial = diagramFromText("Original → Sortie")) {
  class Element extends EventTarget {
    value = ""; textContent = ""; className = ""; disabled = false; files: unknown[] = [];
    onclick?: () => unknown;
    onchange?: () => unknown;
    href = ""; download = "";
    classList = { toggle() {}, add() {}, remove() {} };
    setAttribute() {}
    replaceChildren() {}
    click() { this.onclick?.(); }
    remove() {}
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  element("#resourceSource").value = JSON.stringify(initial);
  element("#resourceName").value = "Mon diagramme";
  const listeners = new Map<string, (event: any) => unknown>();
  const actions: string[] = [], downloads: Element[] = [], confirmations: string[] = [];
  const blobs = new Map<string, Blob>();
  const timers = new Map<number, () => void>();
  let model = initial, confirmation = true, nextTimer = 0;
  const frameWindow = {
    postMessage(request: any) {
      actions.push(request.action);
      queueMicrotask(() => {
        if (request.action === "mount") model = JSON.parse(request.payload.source);
        if (request.action === "import") model = JSON.parse(request.payload.source);
        const value = { source: JSON.stringify(model), count: model.nodes.length, diagramType: model.type };
        listeners.get("message")?.({ origin: "http://studio.test", source: frameWindow,
          data: { channel: request.channel, id: request.id, epoch: request.epoch, ok: true, value } });
      });
    }
  };
  Object.assign(element("#resourceDiagramFrame"), { contentWindow: frameWindow });
  let importApi = async (source: string) => ({ source: JSON.stringify(resourceDiagramModel(source)) });
  const document = {
    querySelector: element, addEventListener() {},
    body: { append(link: Element) { downloads.push(link); } },
    createElement: () => new Element()
  };
  const init = runInNewContext(script.replace("export function initResourceDiagram", "function initResourceDiagram") + "\ninitResourceDiagram;", {
    document, window: {
      addEventListener(name: string, callback: (event: any) => unknown) { listeners.set(name, callback); },
      confirm(text: string) { confirmations.push(text); return confirmation; }
    },
    location: { origin: "http://studio.test" }, Blob, Event, AbortController,
    URL: {
      createObjectURL(blob: Blob) { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url: string) { blobs.delete(url); }
    },
    requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); }
  });
  const editor = init({ api: async (path: string, options: any) => {
    assert.equal(path, "/api/resources/diagram/import");
    return importApi(JSON.parse(options.body).source);
  } });
  editor.show(true);
  listeners.get("message")!({ origin: "http://studio.test", source: frameWindow,
    data: { channel: "dgx-resource-diagram", event: "ready" } });
  await flush();
  const upload = async (text: string, size = new TextEncoder().encode(text).length) => {
    element("#resourceDiagramImportFile").files = [{ size, text: async () => text }];
    await element("#resourceDiagramImportFile").onchange!();
  };
  return { editor, element, actions, downloads, confirmations, blobs, upload,
    confirm(value: boolean) { confirmation = value; },
    setImportApi(callback: typeof importApi) { importApi = callback; },
    currentModel(value: typeof model) { model = value; }
  };
}

test("JSON export uses the current editable model without requesting a PNG, including empty diagrams", async () => {
  const h = await editorHarness();
  for (const model of [diagramFromText("Modification non enregistrée → Étape suivante"), emptyDiagram("ClassDiagram")]) {
    h.currentModel(model);
    await h.element("#exportResourceDiagram").onclick!();
    const download = h.downloads.at(-1)!;
    assert.equal(download.download, "Mon diagramme.apollon.json");
    const blob = h.blobs.get(download.href)!;
    assert.equal(blob.type, "application/json");
    assert.deepEqual(JSON.parse(await blob.text()), model);
    await h.upload(await blob.text());
    assert.deepEqual(JSON.parse(h.editor.getSource()), model, "an exported model can be imported without losing properties");
  }
  assert.equal(h.actions.includes("export"), false, "JSON transfers must work independently of raster rendering");
});

test("JSON import accepts a UTF-8 BOM and keeps the current diagram when invalid, too large or cancelled", async () => {
  const h = await editorHarness();
  const original = h.editor.getSource();
  await h.upload("{broken");
  assert.equal(h.editor.getSource(), original);
  assert.match(h.element("#resourceDiagramStatus").className, /bad/);
  await h.upload("{}", 1024 * 1024 + 1);
  assert.equal(h.editor.getSource(), original);
  assert.match(h.element("#resourceDiagramStatus").textContent, /1 Mo/);
  const imported = emptyDiagram("ClassDiagram");
  h.confirm(false);
  await h.upload(JSON.stringify(imported));
  assert.equal(h.editor.getSource(), original);
  assert.equal(h.actions.includes("import"), false);
  h.confirm(true);
  await h.upload("\uFEFF" + JSON.stringify(imported));
  assert.deepEqual(JSON.parse(h.editor.getSource()), imported);
  assert.equal(h.element("#resourceDiagramType").value, "ClassDiagram");
  assert.match(h.element("#resourceDiagramEditorStatus").textContent, /Diagramme importé/);
  assert.equal(h.element("#resourceDiagramImportFile").value, "");
  assert.equal(h.element("#importResourceDiagram").disabled, false);
});

test("a pending import cannot be saved or replace a resource after navigating away", async () => {
  const h = await editorHarness();
  let complete!: (value: { source: string }) => void;
  h.setImportApi(() => new Promise(resolve => { complete = resolve; }));
  const importing = h.upload(JSON.stringify(emptyDiagram()));
  await flush();
  assert.equal(h.element("#importResourceDiagram").disabled, true);
  await assert.rejects(h.editor.prepareDraft(), /fin de l’import/);
  const next = JSON.stringify(diagramFromText("Autre ressource"));
  h.editor.setSource(next); h.editor.show(false);
  complete({ source: JSON.stringify(emptyDiagram()) });
  await importing;
  assert.equal(h.editor.getSource(), next);
  assert.equal(h.actions.includes("import"), false);
});
