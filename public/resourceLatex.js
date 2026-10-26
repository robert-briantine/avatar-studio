/** Insert editable TeX at the selection and select the next useful placeholder. */
export function latexInsertion(kind, selected = '', hasContent = false) {
  let text;
  let placeholder;
  switch (kind) {
    case 'fraction': text = `\\frac{${selected || 'a'}}{b}`; placeholder = selected ? 'b' : 'a'; break;
    case 'power': text = `${selected ? `{${selected}}` : hasContent ? '' : 'x'}^{2}`; placeholder = '2'; break;
    case 'subscript': text = `${selected ? `{${selected}}` : hasContent ? '' : 'x'}_{1}`; placeholder = '1'; break;
    case 'sqrt': text = `\\sqrt{${selected || 'x'}}`; placeholder = selected ? null : 'x'; break;
    case 'alpha': return { text: '\\alpha ', start: 7, end: 7 };
    case 'beta': return { text: '\\beta ', start: 6, end: 6 };
    case 'pi': return { text: '\\pi ', start: 4, end: 4 };
    case 'infinity': return { text: '\\infty ', start: 7, end: 7 };
    case 'sum': text = '\\sum_{n=1}^{N}'; placeholder = 'N'; break;
    case 'integral': text = '\\int_{a}^{b} f(x)\\,dx'; placeholder = 'a'; break;
    default: throw new Error('Outil LaTeX inconnu.');
  }
  const start = placeholder ? text.lastIndexOf(placeholder) : text.length;
  return { text, start, end: placeholder ? start + placeholder.length : start };
}

export function initResourceLatex({ api, getPresentation = () => ({}) }) {
  const source = document.querySelector('#resourceSource');
  const tools = document.querySelector('#resourceLatexTools');
  const panel = document.querySelector('#resourceLatexPanel');
  const preview = document.querySelector('#resourceLatexPreview');
  const status = document.querySelector('#resourceLatexStatus');
  const refreshButton = document.querySelector('#refreshResourceLatex');
  let active = false;
  let locked = false;
  let timer;
  let controller;
  let revision = 0;

  function message(text, bad = false) {
    status.textContent = text;
    status.className = `status ${bad ? 'bad' : ''}`;
  }

  function invalidate() {
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
    revision++;
    preview.setAttribute('aria-busy', 'false');
  }

  async function render(current, text) {
    if (!active || current !== revision) return;
    const request = new AbortController();
    controller = request;
    try {
      const presentation = getPresentation();
      const data = await api('/api/resources/latex/preview', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: text, ...presentation }), signal: request.signal });
      if (!active || current !== revision || source.value !== text) return;
      const image = document.createElement('img');
      image.alt = presentation.backgroundImageId ? 'Composition de la formule LaTeX sur son image de fond' : 'Aperçu de la formule LaTeX';
      image.src = data.image;
      image.onerror = () => {
        if (current === revision) { preview.textContent = 'Aperçu indisponible.'; message('L’aperçu n’a pas pu être affiché. Réessayez avec le bouton Actualiser.', true); }
      };
      preview.replaceChildren(image);
      message(presentation.backgroundImageId ? 'Composition prête. Formule et image de fond enregistrables ensemble.' : 'Formule valide.');
    } catch (error) {
      if (!active || current !== revision || request.signal.aborted) return;
      preview.textContent = 'Aucun aperçu pour cette saisie.';
      message(error.message, true);
    } finally {
      if (current === revision) preview.setAttribute('aria-busy', 'false');
      if (controller === request) controller = undefined;
    }
  }

  function refresh(immediate = false) {
    invalidate();
    if (!active) return;
    preview.classList.toggle('composed', Boolean(getPresentation().backgroundImageId));
    if (!source.value.trim()) {
      preview.textContent = 'Votre formule apparaîtra ici.';
      message('Saisissez une formule ou utilisez les boutons ci-dessus.');
      return;
    }
    preview.textContent = 'Préparation de l’aperçu…';
    preview.setAttribute('aria-busy', 'true');
    message('Mise à jour de l’aperçu…');
    const current = revision;
    const text = source.value;
    if (immediate) void render(current, text);
    else timer = setTimeout(() => { void render(current, text); }, 300);
  }

  for (const button of tools.querySelectorAll('[data-latex-insert]')) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.onclick = () => {
      if (!active || locked) return;
      const start = source.selectionStart;
      const end = source.selectionEnd;
      const insertion = latexInsertion(button.dataset.latexInsert, source.value.slice(start, end), Boolean(source.value));
      source.setRangeText(insertion.text, start, end, 'end');
      source.focus();
      source.setSelectionRange(start + insertion.start, start + insertion.end);
      source.dispatchEvent(new Event('input', { bubbles: true }));
    };
  }
  source.addEventListener('input', () => refresh());
  refreshButton.onclick = () => refresh(true);

  return {
    refresh() { refresh(); },
    show(visible) {
      active = visible;
      tools.classList.toggle('hidden', !visible);
      panel.classList.toggle('hidden', !visible);
      document.querySelector('#resourceSavedPreview').classList.toggle('hidden', visible);
      refresh();
    },
    setLocked(value) {
      locked = value;
      tools.querySelectorAll('button').forEach(button => { button.disabled = locked; });
      refreshButton.disabled = locked;
    }
  };
}
