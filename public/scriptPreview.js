export function initScriptPreview({ api }) {
  const $ = selector => document.querySelector(selector);
  const source = $('#speechText'), button = $('#previewScript');
  const panel = $('#scriptPreviewPanel'), status = $('#scriptPreviewStatus');
  let revision = 0, controller;
  const labels = { standard: 'Avatar', text: 'Texte sur l’avatar', latex: 'Formule sur l’avatar',
    image: 'Image générée', file: 'Fichier local', ref: 'Ressource de la bibliothèque' };

  function reset() {
    revision++; controller?.abort(); controller = undefined;
    button.disabled = false; button.textContent = 'Vérifier et prévisualiser le scénario';
    panel.classList.add('hidden'); panel.replaceChildren(); status.textContent = ''; status.className = 'status';
  }
  source.addEventListener('input', reset);
  button.onclick = async () => {
    reset();
    const current = revision, text = source.value.trim(), request = new AbortController(); controller = request;
    button.disabled = true; button.textContent = 'Vérification…';
    status.textContent = 'Vérification des commandes, des ressources et des fichiers…';
    try {
      const data = await api('/api/script/preview', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }), signal: request.signal });
      if (current !== revision || source.value.trim() !== text) return;
      const heading = document.createElement('h3'); heading.textContent = 'Paroles qui seront prononcées';
      const narration = document.createElement('p'); narration.className = 'scriptNarration'; narration.textContent = data.narration;
      const steps = document.createElement('ol'); steps.className = 'scriptPreviewSteps';
      for (const sequence of data.sequences) {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = sequence.resource ? `Ressource : ${sequence.resource.name}` : labels[sequence.mode] || sequence.mode;
        item.append(title);
        if (sequence.resource) {
          const image = document.createElement('img'); image.alt = `Aperçu de ${sequence.resource.name}`; image.src = sequence.resource.previewUrl;
          image.onerror = () => {
            if (current === revision) { status.textContent = 'Un visuel est devenu indisponible. Vérifiez la bibliothèque puis relancez l’aperçu.'; status.className = 'status bad'; }
          };
          item.append(image);
        } else if (sequence.content) {
          const visual = document.createElement('code'); visual.textContent = sequence.content; item.append(visual);
        }
        const words = document.createElement('p'); words.textContent = sequence.text; item.append(words); steps.append(item);
      }
      panel.replaceChildren(heading, narration, steps); panel.classList.remove('hidden');
      status.textContent = 'Scénario valide. Les commandes et le contenu des ressources ne sont pas prononcés.';
    } catch (error) {
      if (current !== revision || request.signal.aborted) return;
      status.textContent = error.message; status.className = 'status bad';
    } finally {
      if (current === revision) { button.disabled = false; button.textContent = 'Vérifier et prévisualiser le scénario'; }
      if (controller === request) controller = undefined;
    }
  };
  return { reset };
}
