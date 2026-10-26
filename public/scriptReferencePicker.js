const resourceTypes = [
  { id: 'image', label: 'Image générée' },
  { id: 'latex', label: 'Expression LaTeX' },
  { id: 'typescript', label: 'Code TypeScript' },
  { id: 'diagram', label: 'Diagramme' }
];

/** Find an empty Ref command at the caret, outside literals and other commands. */
export function referenceTrigger(source, caret, selectionEnd = caret) {
  if (!Number.isInteger(caret) || caret < 0 || caret > source.length || selectionEnd !== caret) return null;
  const match = /\{Ref:\s*$/u.exec(source.slice(0, caret));
  if (!match) return null;
  let cursor = 0, depth = 0;
  while (cursor < match.index) {
    const char = source[cursor];
    if (char === '\\' && (depth || /[{}\\]/.test(source[cursor + 1] || ''))) { cursor += 2; continue; }
    if (char === '{') depth++;
    else if (char === '}' && depth) depth--;
    cursor++;
  }
  if (cursor !== match.index || depth) return null;
  const closing = /^[ \t]*\}/u.exec(source.slice(caret));
  return { source, start: match.index, end: caret + (closing?.[0].length || 0), caret };
}

/** Keep the surrounding scenario byte for byte, and escape literal backslashes. */
export function completeReference(source, trigger, name) {
  if (!trigger || trigger.source !== source || typeof name !== 'string' || !name.trim()
    || name !== name.trim() || name.length > 120 || /[{}\u0000-\u001f\u007f]/u.test(name)) return null;
  const command = `{Ref:${name.replace(/\\/g, '\\\\')}}`;
  return { command, value: source.slice(0, trigger.start) + command + source.slice(trigger.end), caret: trigger.start + command.length };
}

export function initScriptReferencePicker({ api, toast }) {
  const dialog = document.querySelector('#scriptReferenceDialog');
  const title = dialog.querySelector('#scriptReferenceTitle'), description = dialog.querySelector('#scriptReferenceDescription');
  const choices = dialog.querySelector('#scriptReferenceChoices'), status = dialog.querySelector('#scriptReferenceStatus');
  const back = dialog.querySelector('#scriptReferenceBack'), retry = dialog.querySelector('#scriptReferenceRetry');
  const selector = '#speechText, #batchRows textarea[data-field="text"]';
  let session = null, inserting = false;

  function dismiss(caret) {
    const previous = session; session = null;
    previous?.request.abort();
    if (dialog.open) dialog.close();
    if (previous?.field.isConnected) {
      const { field, trigger } = previous;
      const scrollTop = field.scrollTop, scrollLeft = field.scrollLeft;
      field.focus({ preventScroll: true });
      if (caret !== undefined || field.value === trigger.source) field.setSelectionRange(caret ?? trigger.caret, caret ?? trigger.caret);
      field.scrollTop = scrollTop; field.scrollLeft = scrollLeft;
    }
  }

  function select(resource) {
    if (!session) return;
    const { field, trigger } = session;
    const completed = completeReference(field.value, trigger, resource.name);
    if (!field.isConnected || !completed) {
      dismiss(); toast('Le scénario a changé. Recommencez la sélection de la référence.', true); return;
    }
    inserting = true;
    try {
      field.setRangeText(completed.command, trigger.start, trigger.end, 'end');
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: completed.command }));
    } finally { inserting = false; }
    dismiss(completed.caret);
  }

  function choice(label, detail, onClick) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'referenceChoice';
    const name = document.createElement('span'); name.textContent = label; button.append(name);
    if (detail) { const hint = document.createElement('small'); hint.textContent = detail; button.append(hint); }
    button.onclick = onClick;
    return button;
  }

  function showNames(type) {
    title.textContent = type.label;
    description.textContent = 'Choisissez le nom à insérer dans le scénario.';
    back.hidden = false; choices.dataset.step = 'names'; choices.replaceChildren();
    const resources = session.resources.filter(resource => resource.type === type.id);
    status.textContent = resources.length ? `${resources.length} ressource${resources.length > 1 ? 's' : ''} disponible${resources.length > 1 ? 's' : ''}.`
      : 'Aucune ressource de ce type n’a de visuel enregistré. Préparez-la dans l’onglet Ressources, puis revenez ici.';
    for (const resource of resources) {
      const button = choice(resource.name, '', () => select(resource)); button.dataset.referenceResource = resource.id; choices.append(button);
    }
    (choices.querySelector('button') || back).focus();
  }

  function showTypes(loading = false) {
    title.textContent = 'Choisir un type de ressource';
    description.textContent = 'Sélectionnez un type, puis le nom de la ressource à afficher.';
    back.hidden = true; retry.hidden = true; choices.dataset.step = 'types'; choices.replaceChildren();
    choices.setAttribute('aria-busy', String(loading));
    status.className = 'status'; status.textContent = loading ? 'Chargement de la bibliothèque…' : 'Seules les ressources avec un visuel enregistré sont proposées.';
    for (const type of resourceTypes) {
      const count = session.resources.filter(resource => resource.type === type.id).length;
      const button = choice(type.label, loading ? '' : `${count} disponible${count > 1 ? 's' : ''}`, () => showNames(type));
      button.dataset.referenceType = type.id; button.disabled = loading; choices.append(button);
    }
    (loading ? title : choices.querySelector('button')).focus();
  }

  async function loadResources(current) {
    showTypes(true);
    try {
      const data = await api('/api/resources', { signal: current.request.signal, cache: 'no-store' });
      if (session !== current || !dialog.open) return;
      current.resources = (data.resources || []).filter(resource => resource.previewUrl
        && resourceTypes.some(type => type.id === resource.type) && completeReference(current.trigger.source, current.trigger, resource.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      showTypes();
    } catch (error) {
      if (session !== current || current.request.signal.aborted) return;
      choices.setAttribute('aria-busy', 'false');
      status.className = 'status bad'; status.textContent = `Impossible de charger la bibliothèque : ${error.message}`;
      retry.hidden = false; retry.focus();
    }
  }

  function onInput(event) {
    const field = event.target;
    if (inserting || session || event.isComposing || !(field instanceof HTMLTextAreaElement)
      || !field.matches(selector) || field.disabled || field.readOnly) return;
    const trigger = referenceTrigger(field.value, field.selectionStart, field.selectionEnd);
    if (!trigger) return;
    session = { field, trigger, resources: [], request: new AbortController() };
    dialog.showModal(); loadResources(session);
  }

  document.addEventListener('input', onInput);
  document.addEventListener('compositionend', onInput);
  back.onclick = () => showTypes();
  retry.onclick = () => { if (session) loadResources(session); };
  dialog.querySelector('#scriptReferenceCancel').onclick = () => dismiss();
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const buttons = [...dialog.querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length);
    const first = buttons[0], last = buttons.at(-1), focused = document.activeElement;
    if (event.shiftKey && (focused === first || !buttons.includes(focused))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (focused === last || !buttons.includes(focused))) { event.preventDefault(); first?.focus(); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { if (!dialog.open && session) dismiss(); });
  return { isOpen: () => dialog.open };
}
