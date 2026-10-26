import { initResourceLatex } from './resourceLatex.js';
import { initResourceCode } from './resourceCode.js';
import { initResourceDiagram } from './resourceDiagram.js';

export function initResourceLibrary({ api, toast, fmtDate }) {
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const state = { resources: [], types: [], selectedId: null, current: null, busy: false, initialized: false, baseline: '', polling: false };
  const sourceFields = {
    image: { label: 'Description de l’image', hint: 'Décrivez l’image, puis lancez sa génération. Le résultat sera enregistré avec cette ressource.', placeholder: 'Un tableau sombre avec un espace central dégagé.' },
    latex: { label: 'Expression LaTeX', hint: 'Utilisez les boutons ou saisissez votre formule. Une sélection peut être placée dans une fraction ou une racine.', placeholder: 'E = mc^{2}' },
    typescript: { label: 'Code TypeScript', hint: 'Coloration VS Code. Tabulations de 4 espaces à l’écran ; source, espaces et lignes conservés. Répartissez les grands extraits entre plusieurs ressources pour garder le visuel lisible.', placeholder: 'const message: string = "Bonjour";' },
    diagram: { label: 'Diagramme', hint: 'Créez les formes et les connexions dans Apollon. L’aperçu correspond au PNG enregistré pour la vidéo.', placeholder: 'Texte du scénario → Génération de la voix → Montage vidéo' }
  };
  const latexEditor = initResourceLatex({ api, getPresentation: presentation });
  const codeEditor = initResourceCode({ api, getPresentation: presentation });
  const diagramEditor = initResourceDiagram({ api, getPresentation: presentation });

  function presentation() {
    return { backgroundImageId: $('#resourceBackground').value,
      ...($('#resourceType').value === 'latex' ? { latexColor: $('#resourceLatexColor').value } : {}), composition: {
      position: $('#resourceCompositionPosition').value, sizePercent: Number($('#resourceCompositionSize').value),
      margin: Number($('#resourceCompositionMargin').value), backgroundFit: $('#resourceCompositionFit').value
    } };
  }

  function draft() {
    const type = $('#resourceType').value;
    return { name: $('#resourceName').value, type, source: type === 'typescript' ? codeEditor.getSource() : type === 'diagram' ? diagramEditor.getSource() : $('#resourceSource').value,
      ...(type === 'typescript' ? { codeTheme: $('#resourceCodeTheme').value } : {}),
      ...(type === 'image' ? { backgroundImageId: '' } : presentation()) };
  }

  function dirty() { return JSON.stringify(draft()) !== state.baseline; }
  function canReplaceDraft() { return !dirty() || window.confirm('Abandonner les modifications non enregistrées de cette ressource ?'); }

  function status(message = '', bad = false) {
    $('#resourceStatus').textContent = message;
    $('#resourceStatus').className = `status ${bad ? 'bad' : ''}`;
  }

  function renderControls() {
    const job = state.current?.imageGeneration;
    const generating = job?.status === 'running';
    const locked = state.busy || generating;
    latexEditor.setLocked(locked);
    codeEditor.setLocked(locked);
    diagramEditor.setLocked(locked);
    const image = $('#resourceType').value === 'image';
    $('#newResource').disabled = state.busy || !state.types.length;
    $('#saveResource').disabled = locked || !state.types.length;
    $('#saveResource').textContent = state.busy ? 'Enregistrement…' : 'Enregistrer la ressource';
    $('#resourceName').disabled = locked;
    $('#resourceType').disabled = locked || Boolean(state.selectedId);
    $('#resourceSource').disabled = locked;
    $('#resourceBackground').disabled = locked;
    $('#resourceLatexColor').disabled = locked;
    $('#resourceLatexColorValue').textContent = $('#resourceLatexColor').value;
    const composing = !image && Boolean($('#resourceBackground').value);
    $('#resourceCompositionSettings').classList.toggle('hidden', !composing);
    for (const selector of ['#resourceCompositionPosition', '#resourceCompositionSize', '#resourceCompositionMargin', '#resourceCompositionFit']) {
      $(selector).disabled = locked || !composing;
    }
    $('#resourceCompositionSizeValue').textContent = `${$('#resourceCompositionSize').value} %`;
    $('#refreshResources').disabled = state.busy;
    $('#resourceDraftBadge').classList.toggle('hidden', !dirty());
    $('#generateResourceImage').classList.toggle('hidden', !image);
    $('#generateResourceImage').disabled = locked || !state.types.length || !$('#resourceName').value.trim() || !$('#resourceSource').value.trim();
    $('#stopResourceImage').classList.toggle('hidden', !generating);
    $('#stopResourceImage').disabled = state.busy;
    const changedSource = image && state.current && state.current.source !== $('#resourceSource').value;
    $('#resourceImageStatus').textContent = changedSource ? 'Description modifiée : générez l’image pour actualiser le visuel.' : image && job ? job.status === 'error' ? job.error || job.message : job.message : '';
    $('#resourceImageStatus').className = `status ${job?.status === 'error' ? 'bad' : ''}`;
  }

  function renderType() {
    const type = $('#resourceType').value;
    const fields = sourceFields[type] || { label: 'Contenu source', hint: '', placeholder: '' };
    $('#resourceSourceLabel').textContent = fields.label;
    $('#resourceSourceHint').textContent = fields.hint;
    $('#resourceSource').placeholder = fields.placeholder;
    $('#resourceSource').classList.toggle('monospace', type !== 'image');
    $('#resourceSource').classList.toggle('latexSource', type === 'latex');
    $('#resourcePreview').classList.toggle('transparentPreview', type === 'latex' || type === 'diagram');
    latexEditor.show(type === 'latex');
    codeEditor.show(type === 'typescript');
    diagramEditor.show(type === 'diagram');
    $('#resourceBackgroundField').classList.toggle('hidden', type === 'image');
    renderControls();
  }

  function renderBackgrounds(selected = $('#resourceBackground').value) {
    $('#resourceBackground').innerHTML = '<option value="">Aucune image de fond</option>' + state.resources
      .filter(resource => resource.type === 'image')
      .map(resource => `<option value="${escape(resource.id)}" ${!resource.previewUrl && resource.id !== selected ? 'disabled' : ''}>${escape(resource.name)}${resource.previewUrl ? '' : ' (image à générer)'}</option>`).join('');
    if (selected && !state.resources.some(resource => resource.id === selected && resource.type === 'image')) {
      const option = document.createElement('option'); option.value = selected; option.textContent = 'Image de fond introuvable';
      $('#resourceBackground').append(option);
    }
    $('#resourceBackground').value = selected;
  }

  function renderList() {
    const search = $('#resourceSearch').value.trim().toLocaleLowerCase('fr');
    const type = $('#resourceFilter').value;
    const resources = state.resources.filter(resource => (!type || resource.type === type) && resource.name.toLocaleLowerCase('fr').includes(search));
    $('#resourceCount').textContent = String(state.resources.length);
    $('#resourceList').innerHTML = resources.length ? resources.map(resource => {
      const label = state.types.find(type => type.id === resource.type)?.label || resource.type;
      const job = resource.imageGeneration;
      const description = job?.status === 'running' ? 'Génération en cours…' : job?.status === 'error' ? 'Échec de génération' : job?.status === 'interrupted' ? 'Génération interrompue' : resource.previewUrl ? resource.type === 'image' ? 'Image enregistrée' : 'Aperçu disponible' : resource.hasSource ? 'Contenu enregistré' : 'Brouillon';
      return `<button type="button" class="resourceItem ${resource.id === state.selectedId ? 'active' : ''}" data-resource="${escape(resource.id)}" ${state.busy ? 'disabled' : ''} aria-pressed="${resource.id === state.selectedId}"><strong>${escape(resource.name)}</strong><span class="badge ${job?.status === 'running' ? 'running' : resource.previewUrl && !job?.error ? 'ready' : ''}">${escape(label)}</span><small>${escape(description)} · ${escape(fmtDate(resource.updatedAt))}</small></button>`;
    }).join('') : `<div class="empty">${state.resources.length ? 'Aucune ressource ne correspond à cette recherche.' : 'Aucune ressource enregistrée. Créez votre première ressource.'}</div>`;
    document.querySelectorAll('[data-resource]').forEach(button => {
      button.onclick = () => loadResource(button.dataset.resource);
    });
  }

  function showResource(resource) {
    state.current = resource;
    state.selectedId = resource?.id || null;
    $('#resourceName').value = resource?.name || '';
    $('#resourceType').value = resource?.type || state.types[0]?.id || '';
    codeEditor.setSource(resource?.source || '');
    diagramEditor.setSource(resource?.source || '');
    $('#resourceCodeTheme').value = resource?.codeTheme || 'dark-plus';
    $('#resourceLatexColor').value = resource?.latexColor || '#17231d';
    $('#resourceCompositionPosition').value = resource?.composition?.position || 'center';
    $('#resourceCompositionSize').value = resource?.composition?.sizePercent ?? 80;
    $('#resourceCompositionMargin').value = resource?.composition?.margin ?? 64;
    $('#resourceCompositionFit').value = resource?.composition?.backgroundFit || 'contain';
    renderBackgrounds(resource?.backgroundImageId || '');
    $('#resourceEditorTitle').textContent = resource ? resource.name : 'Nouvelle ressource';
    $('#resourceEditorMeta').textContent = resource ? `Modifiée le ${fmtDate(resource.updatedAt)}` : 'Choisissez un type et enregistrez son contenu.';
    const preview = $('#resourcePreview');
    preview.replaceChildren();
    if (resource?.previewUrl) {
      const image = document.createElement('img');
      image.src = resource.previewUrl;
      image.alt = `Aperçu de ${resource.name}`;
      image.onerror = () => { preview.textContent = 'L’aperçu enregistré est indisponible.'; };
      preview.append(image);
    } else preview.textContent = 'Aucun aperçu disponible.';
    state.baseline = JSON.stringify(draft());
    status();
    renderType();
    renderList();
  }

  async function refreshList() {
    const data = await api('/api/resources');
    const selectedType = $('#resourceType').value;
    const filter = $('#resourceFilter').value;
    state.resources = data.resources;
    state.types = data.types;
    $('#resourceType').innerHTML = state.types.map(type => `<option value="${escape(type.id)}">${escape(type.label)}</option>`).join('');
    if (selectedType) $('#resourceType').value = selectedType;
    $('#resourceFilter').innerHTML = '<option value="">Tous les types</option>' + state.types.map(type => `<option value="${escape(type.id)}">${escape(type.label)}</option>`).join('');
    $('#resourceFilter').value = filter;
    renderBackgrounds();
    $('#resourceListStatus').textContent = '';
    renderList();
    renderControls();
  }

  async function loadResource(id) {
    if (state.busy || id === state.selectedId || !canReplaceDraft()) return;
    state.busy = true;
    renderControls();
    renderList();
    try { showResource((await api(`/api/resources/${encodeURIComponent(id)}`)).resource); }
    catch (error) { status(error.message, true); }
    finally { state.busy = false; renderControls(); renderList(); }
  }

  $('#newResource').onclick = () => {
    if (state.busy || !canReplaceDraft()) return;
    showResource(null);
    $('#resourceName').focus();
  };
  $('#resourceSearch').oninput = renderList;
  $('#resourceFilter').onchange = renderList;
  $('#resourceType').onchange = renderType;
  for (const selector of ['#resourceName', '#resourceSource', '#resourceBackground', '#resourceCodeTheme']) {
    $(selector).addEventListener('input', renderControls);
  }
  function refreshPresentation() {
    renderControls(); latexEditor.refresh(); codeEditor.refresh(); diagramEditor.refresh();
  }
  $('#resourceBackground').addEventListener('change', refreshPresentation);
  $('#resourceLatexColor').addEventListener('input', refreshPresentation);
  for (const selector of ['#resourceCompositionPosition', '#resourceCompositionSize', '#resourceCompositionMargin', '#resourceCompositionFit']) {
    $(selector).addEventListener('input', refreshPresentation);
  }
  $('#resourceForm').onsubmit = async event => {
    event.preventDefault();
    if (state.busy || !state.types.length) return;
    const body = draft();
    if (!body.name.trim()) { status('Le nom de la ressource est obligatoire.', true); $('#resourceName').focus(); return; }
    state.busy = true;
    renderControls();
    renderList();
    status('Enregistrement de la ressource…');
    try {
      await saveDraft();
      status('Ressource enregistrée.');
      toast('Ressource enregistrée dans la bibliothèque commune.');
    } catch (error) { status(error.message, true); }
    finally { state.busy = false; renderControls(); renderList(); }
  };

  async function saveDraft() {
    let body = draft();
    if (body.type === 'diagram') body = { ...body, ...await diagramEditor.prepareDraft() };
    const resource = (await api(state.selectedId ? `/api/resources/${encodeURIComponent(state.selectedId)}` : '/api/resources', {
      method: state.selectedId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })).resource;
    showResource(resource);
    await refreshList();
    return resource;
  }

  $('#generateResourceImage').onclick = async () => {
    if ($('#generateResourceImage').disabled) return;
    state.busy = true;
    renderControls();
    renderList();
    status('Préparation de la génération…');
    try {
      if (!state.selectedId || dirty()) await saveDraft();
      const data = await api(`/api/resources/${encodeURIComponent(state.selectedId)}/generate-image`, { method: 'POST' });
      showResource(data.resource);
      await refreshList();
      toast('Préparation de l’image lancée.');
    } catch (error) { status(error.message, true); }
    finally { state.busy = false; renderControls(); renderList(); }
  };

  $('#stopResourceImage').onclick = async () => {
    if (!state.selectedId || state.busy) return;
    state.busy = true;
    renderControls();
    try {
      await api(`/api/resources/${encodeURIComponent(state.selectedId)}/generate-image/stop`, { method: 'POST' });
      status('Arrêt de la génération demandé…');
    } catch (error) { status(error.message, true); }
    finally { state.busy = false; renderControls(); }
  };

  async function pollImages() {
    if (state.polling || state.busy) return;
    const running = new Set(state.resources.filter(resource => resource.imageGeneration?.status === 'running').map(resource => resource.id));
    if (state.current?.imageGeneration?.status === 'running') running.add(state.current.id);
    if (!running.size) return;
    state.polling = true;
    try {
      await refreshList();
      const selectedId = state.selectedId;
      if (selectedId && running.has(selectedId) && !dirty() && !state.busy) {
        const { resource } = await api(`/api/resources/${encodeURIComponent(selectedId)}`);
        if (state.selectedId === selectedId && !dirty() && !state.busy) showResource(resource);
      }
      for (const id of running) {
        const resource = state.resources.find(item => item.id === id);
        const job = resource?.imageGeneration;
        if (job && job.status !== 'running') toast(`${resource.name} : ${job.status === 'error' ? job.error || job.message : job.message}`, job.status === 'error');
      }
    } catch (error) { console.warn('Suivi des images indisponible :', error); }
    finally { state.polling = false; }
  }

  async function open() {
    if (state.busy) return;
    try {
      await refreshList();
      if (!state.initialized) { showResource(null); state.initialized = true; }
    } catch (error) {
      $('#resourceListStatus').textContent = error.message;
      $('#resourceListStatus').className = 'status bad';
      if (!state.initialized) $('#resourceList').textContent = 'La bibliothèque est indisponible. Utilisez « Actualiser » pour réessayer.';
    }
  }
  $('#refreshResources').onclick = open;
  state.baseline = JSON.stringify(draft());
  setInterval(pollImages, 2000);
  return { open };
}
