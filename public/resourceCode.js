let editorAssets;
function loadEditorAssets() {
  if (!editorAssets) {
    const css = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '/editor-assets/code-editor.css';
      link.onload = resolve;
      link.onerror = () => { link.remove(); reject(new Error('La feuille de style de Monaco est indisponible.')); };
      document.head.append(link);
    });
    editorAssets = Promise.all([import('/editor-assets/code-editor.js'), css])
      .then(([module]) => module).catch(error => { editorAssets = undefined; throw error; });
  }
  return editorAssets;
}

export function initResourceCode({ api, getPresentation = () => ({}) }) {
  const $ = selector => document.querySelector(selector);
  const source = $('#resourceSource');
  const container = $('#resourceCodeEditor');
  const theme = $('#resourceCodeTheme');
  const preview = $('#resourceCodePreview');
  const status = $('#resourceCodeStatus');
  const editorStatus = $('#resourceCodeEditorStatus');
  let active = false, locked = false, editor, initializing, fromEditor = false;
  let exactSource = source.value;
  let timer, controller, revision = 0;

  function message(text, bad = false) {
    status.textContent = text;
    status.className = `status ${bad ? 'bad' : ''}`;
  }
  function renderVisibility() {
    if ($('#resourceType').value !== 'diagram') source.classList.toggle('hidden', active && Boolean(editor));
    container.classList.toggle('hidden', !active || !editor);
    $('#resourceCodeThemeField').classList.toggle('hidden', !active);
    $('#resourceCodePanel').classList.toggle('hidden', !active);
    editorStatus.classList.toggle('hidden', !active);
    if (active) $('#resourceSavedPreview').classList.add('hidden');
    if ($('#resourceType').value !== 'diagram') $('#resourceSourceLabel').htmlFor = active && editor ? 'resourceCodeEditor' : 'resourceSource';
  }
  async function ensureEditor() {
    if (editor || initializing) return initializing;
    editorStatus.textContent = 'Chargement de Monaco Editor…';
    editorStatus.className = 'status';
    initializing = (async () => {
      try {
        const { createCodeEditor } = await loadEditorAssets();
        editor = await createCodeEditor(container, {
          source: exactSource, theme: theme.value, readOnly: locked,
          onChange(text) {
            if (!active || locked) return;
            exactSource = text;
            source.value = text;
            fromEditor = true;
            try { source.dispatchEvent(new Event('input', { bubbles: true })); }
            finally { fromEditor = false; }
          }
        });
        // Selection may have changed while Monaco was loading.
        if (active) { editor.setSource(exactSource); editor.setTheme(theme.value); }
        editor.setLocked(locked);
        editorStatus.textContent = 'Tab : indenter · Ctrl+M : permettre de quitter l’éditeur avec Tab.';
      } catch (error) {
        editorStatus.replaceChildren(document.createTextNode(`Monaco n’a pas pu être chargé : ${error.message} `));
        editorStatus.className = 'status bad';
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'btn secondary smallBtn'; retry.textContent = 'Réessayer';
        retry.onclick = () => { void ensureEditor(); };
        editorStatus.append(retry);
      } finally {
        initializing = undefined;
        renderVisibility();
        if (active && editor) editor.layout();
      }
    })();
    return initializing;
  }
  function invalidate() {
    clearTimeout(timer);
    controller?.abort(); controller = undefined;
    revision++;
    preview.setAttribute('aria-busy', 'false');
  }
  async function render(current, text, codeTheme) {
    if (!active || current !== revision) return;
    const request = new AbortController(); controller = request;
    try {
      const data = await api('/api/resources/typescript/preview', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: text, codeTheme, ...getPresentation() }), signal: request.signal });
      if (!active || current !== revision || exactSource !== text || theme.value !== codeTheme) return;
      const image = document.createElement('img');
      image.alt = 'Visuel du code TypeScript avec le thème choisi'; image.src = data.image;
      image.onerror = () => {
        if (current === revision) { preview.textContent = 'Aperçu indisponible.'; message('L’image n’a pas pu être affichée. Actualisez l’aperçu.', true); }
      };
      preview.replaceChildren(image);
      message('Visuel 1472 × 1104 px. Le cadrage s’adapte au code sans couper les lignes.');
    } catch (error) {
      if (!active || current !== revision || request.signal.aborted) return;
      preview.textContent = 'Aucun aperçu pour cette saisie.'; message(error.message, true);
    } finally {
      if (current === revision) preview.setAttribute('aria-busy', 'false');
      if (controller === request) controller = undefined;
    }
  }
  function refresh(immediate = false) {
    invalidate();
    if (!active) return;
    if (!exactSource.trim()) {
      preview.textContent = 'Votre code apparaîtra ici.'; message('Saisissez du code dans Monaco Editor.'); return;
    }
    preview.textContent = 'Préparation du visuel…'; preview.setAttribute('aria-busy', 'true'); message('Mise à jour de l’aperçu…');
    const current = revision, text = exactSource, codeTheme = theme.value;
    if (immediate) void render(current, text, codeTheme);
    else timer = setTimeout(() => { void render(current, text, codeTheme); }, 350);
  }
  source.addEventListener('input', () => {
    if (!fromEditor) {
      exactSource = source.value;
      if (active) editor?.setSource(exactSource);
    }
    refresh();
  });
  theme.addEventListener('change', () => {
    if (active) editor?.setTheme(theme.value);
    refresh();
  });
  $('#resourceSourceLabel').addEventListener('click', () => { if (active) editor?.focus(); });
  $('#refreshResourceCode').onclick = () => refresh(true);

  return {
    refresh() { refresh(); },
    getSource() { return exactSource; },
    setSource(text) { exactSource = text; source.value = text; if (active) editor?.setSource(text); },
    show(visible) {
      active = visible; renderVisibility();
      if (active) {
        if (editor) { editor.setSource(exactSource); editor.setTheme(theme.value); editor.layout(); }
        else void ensureEditor();
      }
      refresh();
    },
    setLocked(value) {
      locked = value; editor?.setLocked(value);
      theme.disabled = value; $('#refreshResourceCode').disabled = value;
    }
  };
}
