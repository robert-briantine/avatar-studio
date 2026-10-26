const channel = 'dgx-resource-diagram';

export function initResourceDiagram({ api, getPresentation = () => ({}) }) {
  const $ = selector => document.querySelector(selector);
  const source = $('#resourceSource');
  const frame = $('#resourceDiagramFrame');
  const panel = $('#resourceDiagramPanel');
  const preview = $('#resourceDiagramPreview');
  const status = $('#resourceDiagramStatus');
  const editorStatus = $('#resourceDiagramEditorStatus');
  const type = $('#resourceDiagramType');
  const importFile = $('#resourceDiagramImportFile');
  const pending = new Map();
  let active = false, locked = false, ready = false, fromFrame = false, legacy = false, importing = false;
  let exactSource = source.value, epoch = 0, mountedEpoch = -1, sequence = 0, count = 0;
  let loading, resolveLoading, rejectLoading, loadingTimer, mounting;
  let timer, controller, revision = 0, cached;

  function message(text, bad = false) { status.textContent = text; status.className = `status ${bad ? 'bad' : ''}`; }
  function candidate(text) {
    if (!text.trim()) return true;
    try { return Boolean(JSON.parse(text)?.version); } catch { return false; }
  }
  function visibility() {
    panel.classList.toggle('hidden', !active);
    $('#resourceDiagramWorkspace').classList.toggle('hidden', !active);
    $('#resourcesView').classList.toggle('editingDiagram', active);
    if (active) {
      source.classList.toggle('hidden', mountedEpoch === epoch && !legacy);
      $('#resourceSavedPreview').classList.add('hidden');
      $('#resourceSourceLabel').htmlFor = mountedEpoch === epoch && !legacy ? 'resourceDiagramFrame' : 'resourceSource';
    }
    frame.classList.toggle('hidden', legacy);
    $('#convertResourceDiagram').classList.toggle('hidden', !legacy);
    const unavailable = locked || importing || mountedEpoch !== epoch || legacy;
    type.disabled = unavailable;
    $('#exampleResourceDiagram').disabled = unavailable || type.value !== 'Flowchart';
    $('#fitResourceDiagram').disabled = unavailable;
    $('#expandResourceDiagram').disabled = unavailable;
    $('#importResourceDiagram').disabled = unavailable;
    $('#exportResourceDiagram').disabled = unavailable;
    importFile.disabled = unavailable;
    $('#convertResourceDiagram').disabled = locked;
    $('#refreshResourceDiagram').disabled = unavailable;
  }
  function load() {
    if (ready) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => { resolveLoading = resolve; rejectLoading = reject; });
    loadingTimer = setTimeout(() => {
      rejectLoading(new Error('Apollon n’a pas pu être chargé. Utilisez « Réessayer » pour relancer l’éditeur.'));
      loading = undefined;
    }, 15_000);
    frame.src = '/resourceDiagramFrame.html';
    return loading;
  }
  function rpc(action, payload = {}, current = epoch) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('L’éditeur met trop de temps à répondre. Réessayez.')); }, 20_000);
      pending.set(id, { resolve, reject, timeout, epoch: current });
      frame.contentWindow.postMessage({ channel, id, action, payload, epoch: current }, location.origin);
    });
  }
  function invalidate() {
    clearTimeout(timer); controller?.abort(); controller = undefined;
    revision++; preview.setAttribute('aria-busy', 'false');
  }
  function changed(text) {
    exactSource = text; source.value = text; cached = undefined;
    fromFrame = true;
    try { source.dispatchEvent(new Event('input', { bubbles: true })); }
    finally { fromFrame = false; }
    refresh();
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.channel !== channel) return;
    const data = event.data;
    if (data.id) {
      const request = pending.get(data.id);
      if (!request || request.epoch !== data.epoch) return;
      pending.delete(data.id); clearTimeout(request.timeout);
      if (data.ok) request.resolve(data.value);
      else request.reject(new Error(data.error));
    } else if (data.event === 'ready') {
      ready = true; clearTimeout(loadingTimer); resolveLoading?.(); loading = undefined;
    } else if (data.event === 'change' && active && data.epoch === epoch) {
      type.value = data.diagramType; count = data.count; changed(data.source); visibility();
    }
  });

  async function mountCurrent() {
    const current = epoch;
    if (!active) return;
    legacy = !candidate(exactSource);
    visibility();
    if (legacy) {
      editorStatus.textContent = 'Ancien contenu conservé. « Convertir le texte » transforme chaque étape séparée par → ou une nouvelle ligne en une forme éditable.';
      message('Convertissez le texte pour obtenir un diagramme graphique et son aperçu.');
      preview.textContent = 'Aucun visuel graphique pour cette description.';
      return;
    }
    editorStatus.textContent = 'Chargement de l’éditeur Apollon…'; editorStatus.className = 'status';
    preview.textContent = 'Préparation du diagramme…'; preview.setAttribute('aria-busy', 'true');
    message('Chargement du diagramme…');
    $('#retryResourceDiagram').classList.add('hidden');
    try {
      await load();
      if (!active || current !== epoch) return;
      const metadata = await rpc('mount', { source: exactSource, locked }, current);
      if (!active || current !== epoch || !metadata) return;
      mountedEpoch = current; count = metadata.count; type.value = metadata.diagramType;
      await rpc('lock', { locked }, current);
      if (!active || current !== epoch) return;
      editorStatus.textContent = 'Ajoutez une forme depuis la palette, déplacez-la, puis reliez ses poignées. Double-cliquez sur une forme ou un lien pour modifier ses propriétés.';
      visibility();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (active && current === epoch) await rpc('fit', {}, current);
      if (active && current === epoch) refresh();
    } catch (error) {
      if (!active || current !== epoch) return;
      editorStatus.textContent = error.message; editorStatus.className = 'status bad';
      preview.textContent = 'Aucun aperçu disponible.'; preview.setAttribute('aria-busy', 'false'); message(error.message, true);
      $('#retryResourceDiagram').classList.remove('hidden'); visibility();
    }
  }
  async function exported(current = epoch) {
    if (cached?.epoch === current && cached.sourceKey === exactSource) return cached.data;
    await mounting;
    if (current !== epoch || !active || mountedEpoch !== current) throw new Error('L’éditeur du diagramme n’est pas prêt. Réessayez après son chargement.');
    const sourceKey = exactSource;
    const data = await rpc('export', {}, current);
    if (current !== epoch || sourceKey !== exactSource) throw new Error('Le diagramme a changé pendant l’export. Réessayez.');
    cached = { epoch: current, sourceKey, data };
    return data;
  }
  async function render(current, context) {
    if (!active || current !== revision || context !== epoch || legacy || mountedEpoch !== epoch) return;
    if (!count) { preview.textContent = 'Votre diagramme apparaîtra ici.'; message('Ajoutez une forme ou utilisez « Ajouter l’exemple ».'); return; }
    const request = new AbortController(); controller = request;
    try {
      const data = await exported(context);
      if (!active || current !== revision || context !== epoch) return;
      const image = await api('/api/resources/diagram/preview', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, ...getPresentation() }), signal: request.signal });
      if (!active || current !== revision || context !== epoch) return;
      const node = document.createElement('img'); node.alt = 'Visuel du diagramme Apollon'; node.src = image.image;
      node.onerror = () => { if (current === revision) message('L’aperçu n’a pas pu être affiché. Actualisez-le.', true); };
      preview.replaceChildren(node); message(getPresentation().backgroundImageId
        ? 'Composition 1472 × 1104 px. Le diagramme reste éditable et son fond est réutilisé.'
        : 'Visuel 1472 × 1104 px. Formes, liens et libellés conservés sur fond transparent.');
    } catch (error) {
      if (!active || current !== revision || context !== epoch || request.signal.aborted) return;
      preview.textContent = 'Aucun aperçu pour ce diagramme.'; message(error.message, true);
    } finally {
      if (current === revision) preview.setAttribute('aria-busy', 'false');
      if (controller === request) controller = undefined;
    }
  }
  function refresh(immediate = false) {
    invalidate();
    if (!active || legacy || mountedEpoch !== epoch) return;
    if (!count) { preview.textContent = 'Votre diagramme apparaîtra ici.'; message('Ajoutez une forme ou utilisez « Ajouter l’exemple ».'); return; }
    preview.textContent = 'Préparation du visuel…'; preview.setAttribute('aria-busy', 'true'); message('Mise à jour de l’aperçu…');
    const current = revision, context = epoch;
    if (immediate) void render(current, context);
    else timer = setTimeout(() => { void render(current, context); }, 450);
  }
  async function action(name, payload) {
    try { await rpc(name, payload); }
    catch (error) { message(error.message, true); }
  }
  $('#exampleResourceDiagram').onclick = () => { if (!locked) void action('example'); };
  $('#fitResourceDiagram').onclick = () => { void action('fit'); };
  $('#refreshResourceDiagram').onclick = () => refresh(true);
  $('#importResourceDiagram').onclick = () => {
    if (!active || locked || importing || mountedEpoch !== epoch || legacy) return;
    importFile.value = '';
    importFile.click();
  };
  importFile.onchange = async () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file || !active || locked || importing || mountedEpoch !== epoch || legacy) return;
    const current = epoch, sourceKey = exactSource;
    importing = true; visibility();
    try {
      if (file.size > 1024 * 1024) throw new Error('Le fichier du diagramme est limité à 1 Mo.');
      const text = (await file.text()).replace(/^\uFEFF/, '');
      if (!active || current !== epoch || locked) return;
      const data = await api('/api/resources/diagram/import', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: text }) });
      if (!active || current !== epoch || locked) return;
      if (sourceKey !== exactSource) throw new Error('Le diagramme a changé pendant l’import. Réessayez.');
      if (count && !window.confirm('Remplacer le diagramme en cours par le fichier importé ? Les modifications non enregistrées seront perdues.')) return;
      const model = await rpc('import', { source: data.source }, current);
      if (!active || current !== epoch) return;
      count = model.count; type.value = model.diagramType;
      if (exactSource !== model.source) changed(model.source);
      editorStatus.textContent = 'Diagramme importé. Vous pouvez le modifier puis enregistrer la ressource.';
      editorStatus.className = 'status';
    } catch (error) {
      if (active && current === epoch) message(error.message, true);
    } finally { importing = false; visibility(); }
  };
  $('#exportResourceDiagram').onclick = async () => {
    if (!active || locked || importing || mountedEpoch !== epoch || legacy) return;
    const current = epoch;
    try {
      const data = await rpc('snapshot', {}, current);
      if (!active || current !== epoch) return;
      const json = JSON.stringify(JSON.parse(data.source), null, 2) + '\n';
      const name = ($('#resourceName').value.trim() || 'diagramme').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${name}.apollon.json`;
      try { document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      message('Diagramme exporté au format JSON Apollon.');
    } catch (error) { if (active && current === epoch) message(error.message, true); }
  };
  type.onchange = () => {
    if (locked) return;
    const next = type.value;
    if (count && !window.confirm('Changer de type effacera les formes et les liens du diagramme en cours. Continuer ?')) {
      try { type.value = JSON.parse(exactSource).type; } catch { type.value = 'Flowchart'; }
      return;
    }
    void action('type', { type: next });
  };
  $('#convertResourceDiagram').onclick = async () => {
    if (locked) return;
    const current = epoch;
    try {
      await load();
      if (!active || current !== epoch) return;
      legacy = false; visibility();
      const data = await rpc('convert', { text: exactSource, locked }, current);
      if (!active || current !== epoch) return;
      mountedEpoch = current; legacy = false; count = data.count; type.value = data.diagramType;
      changed(data.source); visibility(); editorStatus.textContent = 'Texte converti. Vous pouvez maintenant déplacer les formes, modifier leurs libellés et ajuster les liens.';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (active && current === epoch) await rpc('fit', {}, current);
    } catch (error) { legacy = !candidate(exactSource); visibility(); message(error.message, true); }
  };
  $('#retryResourceDiagram').onclick = () => { mounting = mountCurrent(); };
  $('#expandResourceDiagram').onclick = async () => {
    try {
      const workspace = $('#resourceDiagramWorkspace');
      if (document.fullscreenElement === workspace) await document.exitFullscreen();
      else await workspace.requestFullscreen();
    } catch { message('Le plein écran n’est pas disponible dans ce navigateur.', true); }
  };
  document.addEventListener('fullscreenchange', () => {
    $('#expandResourceDiagram').textContent = document.fullscreenElement ? 'Réduire' : 'Agrandir';
    if (active && mountedEpoch === epoch) setTimeout(() => { void action('fit'); }, 100);
  });
  source.addEventListener('input', () => {
    if (fromFrame || !active) return;
    exactSource = source.value; epoch++; cached = undefined; invalidate(); mounting = mountCurrent();
  });
  return {
    refresh() { refresh(); },
    getSource() { return exactSource; },
    setSource(text) { exactSource = text; epoch++; cached = undefined; invalidate(); },
    async prepareDraft() {
      if (importing) throw new Error('Attendez la fin de l’import avant d’enregistrer la ressource.');
      if (!candidate(exactSource)) return { source: exactSource };
      await mounting;
      if (mountedEpoch === epoch) await rpc('lock', { locked: true });
      const { source, diagramPreview } = await exported();
      return { source, ...(diagramPreview ? { diagramPreview } : {}) };
    },
    show(visible) {
      const wasActive = active; active = visible;
      if (active && !wasActive) { exactSource = source.value; epoch++; cached = undefined; }
      visibility();
      if (active && mountedEpoch !== epoch) mounting = mountCurrent();
      else if (active) refresh();
      if (!active) {
        invalidate();
        if (wasActive && ready && mountedEpoch === epoch) void rpc('lock', { locked: true }).catch(() => {});
      }
    },
    setLocked(value) {
      const changed = locked !== value; locked = value; visibility();
      if (changed && active && mountedEpoch === epoch) void rpc('lock', { locked: value }).catch(error => message(error.message, true));
    }
  };
}
