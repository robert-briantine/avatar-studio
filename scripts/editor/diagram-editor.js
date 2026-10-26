import { ApollonEditor } from '@tumaet/apollon';
import { svgToPng } from '@tumaet/apollon/export';
import '@tumaet/apollon/style.css';
import { diagramFromText, emptyDiagram, parseDiagramModel } from '../../src/diagramModel.ts';

const channel = 'dgx-resource-diagram';
const origin = location.origin;
const root = document.querySelector('#diagramRoot');
const labels = {
  zoomToolbar: 'Zoom du diagramme', zoomIn: 'Agrandir', zoomOut: 'Réduire', fitView: 'Tout afficher',
  resetZoom: 'Zoom à 100 %', zoomReadout: percent => `Zoom : ${percent} %`,
  undo: 'Annuler', undoHint: 'Annuler (Ctrl+Z)', redo: 'Rétablir', redoHint: 'Rétablir (Ctrl+Maj+Z)',
  multiSelection: 'Sélection multiple', multiSelectionHint: 'Sélectionner plusieurs éléments',
  miniMap: 'Vue d’ensemble', showMinimap: 'Afficher la vue d’ensemble', showMinimapHint: 'Afficher la vue d’ensemble',
  hideMinimap: 'Masquer la vue d’ensemble', selectionActions: 'Actions de sélection',
  elementPalette: 'Formes du diagramme', addElement: 'Ajouter un élément', paletteModelView: 'Formes',
  edge: 'Lien', label: 'Libellé', type: 'Type', connection: 'Connexion', stereotype: 'Stéréotype', object: 'Objet',
  source: 'Départ', target: 'Arrivée', style: 'Style', selectPlaceholder: 'Choisir…', node: 'Élément',
  attribute: 'Attribut', method: 'Méthode', color: 'Couleur', name: 'Nom',
  editElement: 'Modifier l’élément', deleteElement: 'Supprimer l’élément', editEdge: 'Modifier le lien', deleteEdge: 'Supprimer le lien',
  lineColor: 'Couleur du contour', textColor: 'Couleur du texte', fillColor: 'Couleur du fond',
  namePlaceholder: 'Nom', editColors: 'Modifier les couleurs', customColor: 'Couleur personnalisée', reset: 'Réinitialiser',
  edgeType: 'Type de lien', swapSourceTarget: 'Inverser le lien',
  nodeTypeLabel: type => ({ flowchartTerminal: 'Début / Fin', flowchartProcess: 'Traitement',
    flowchartDecision: 'Décision', flowchartInputOutput: 'Entrée / Sortie', flowchartFunctionCall: 'Sous-programme',
    class: 'Classe', package: 'Paquet', activityActionNode: 'Action', activityInitialNode: 'Début',
    activityFinalNode: 'Fin', activityMergeNode: 'Décision / Fusion', activityObjectNode: 'Objet',
    activityForkNode: 'Séparation / Jonction', activityForkNodeHorizontal: 'Jonction horizontale',
    activitySwimlane: 'Couloir', activity: 'Activité', useCase: 'Cas d’utilisation', useCaseActor: 'Acteur',
    useCaseSystem: 'Système', component: 'Composant', deploymentNode: 'Nœud', bpmnTask: 'Tâche',
    bpmnStartEvent: 'Début', bpmnEndEvent: 'Fin', bpmnGateway: 'Passerelle', colorDescription: 'Légende',
    titleAndDesctiption: 'Titre et description' }[type] || type || 'Élément')
};
let editor, epoch = 0, locked = false, syncing = false, baseline = '', wasmInput;
let exports = Promise.resolve();
const send = payload => parent.postMessage({ channel, ...payload }, origin);
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
const snapshot = () => JSON.stringify(editor.model);

async function mount(source, nextEpoch, readOnly) {
  epoch = nextEpoch; locked = readOnly; syncing = true;
  editor?.destroy(); editor = undefined;
  const model = source.trim() ? parseDiagramModel(source) : emptyDiagram();
  editor = new ApollonEditor(root, { model, dataTheme: 'light', readonly: readOnly, scrollLock: true, labels });
  const current = editor;
  current.subscribeToModelChange(() => {
    if (current !== editor || syncing || locked) return;
    const source = snapshot();
    if (source === baseline) return;
    baseline = source;
    send({ event: 'change', epoch, source, diagramType: current.model.type, count: current.model.nodes.length });
  });
  await document.fonts.ready; await nextFrame(); await nextFrame();
  if (current !== editor) return;
  baseline = snapshot(); syncing = false;
  current.fitView({ duration: 0 });
  return { diagramType: model.type, count: model.nodes.length };
}

function updateModel(model) {
  if (locked) throw new Error('Le diagramme est temporairement verrouillé.');
  syncing = true;
  try { editor.model = model; baseline = snapshot(); }
  finally { syncing = false; }
  send({ event: 'change', epoch, source: baseline, diagramType: model.type, count: model.nodes.length });
  requestAnimationFrame(() => editor.fitView({ duration: 0 }));
}

async function exportDiagram(model) {
  const source = JSON.stringify(model);
  if (!model.nodes.length) return { source, count: 0 };
  const { svg, clip } = await ApollonEditor.exportModelAsSvg(model, { svgMode: 'compat' });
  const fit = Math.min(1344 / clip.width, 976 / clip.height);
  if (!Number.isFinite(fit) || fit < 0.875) {
    throw new Error('Le diagramme est trop étendu pour un visuel lisible. Rapprochez ses éléments ou répartissez-le entre plusieurs ressources.');
  }
  wasmInput ??= fetch(new URL('resvg.wasm', import.meta.url));
  const { blob, clamped } = await svgToPng(svg, clip, { scale: Math.min(2, fit), background: null, wasmInput, maxDimensionPx: 4096 });
  if (clamped) throw new Error('Le diagramme est trop grand. Rapprochez ses éléments avant de réessayer.');
  const diagramPreview = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
  return { source, diagramPreview, count: model.nodes.length };
}

window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== origin || event.data?.channel !== channel) return;
  const { id, action, payload = {}, epoch: requestedEpoch } = event.data;
  try {
    let value;
    if (action === 'mount') value = await mount(payload.source, requestedEpoch, payload.locked);
    else if (action === 'convert') {
      const model = diagramFromText(payload.text);
      await mount(JSON.stringify(model), requestedEpoch, payload.locked);
      value = { source: snapshot(), diagramType: model.type, count: model.nodes.length };
    } else {
      if (!editor || requestedEpoch !== epoch) throw new Error('Le diagramme sélectionné a changé.');
      if (action === 'lock') { locked = payload.locked; editor.setReadonly(locked); }
      else if (action === 'fit') editor.fitView({ duration: 0 });
      else if (action === 'import') {
        updateModel(parseDiagramModel(payload.source));
        value = { source: snapshot(), diagramType: editor.model.type, count: editor.model.nodes.length };
      } else if (action === 'snapshot') {
        const source = snapshot();
        parseDiagramModel(source);
        value = { source };
      }
      else if (action === 'type') updateModel(emptyDiagram(payload.type));
      else if (action === 'example') {
        const model = editor.model;
        if (model.type !== 'Flowchart') throw new Error('L’exemple utilise le type Organigramme.');
        const example = diagramFromText('Texte du scénario → Génération de la voix → Montage vidéo');
        const bottom = Math.max(0, ...model.nodes.map(node => node.position.y + node.height));
        example.nodes.forEach(node => { node.position.y += model.nodes.length ? bottom + 100 : 0; });
        updateModel({ ...model, nodes: [...model.nodes, ...example.nodes], edges: [...model.edges, ...example.edges] });
      } else if (action === 'export') {
        const model = editor.model;
        parseDiagramModel(JSON.stringify(model));
        const operation = exports.then(() => exportDiagram(model));
        exports = operation.then(() => undefined, () => undefined);
        value = await operation;
      } else throw new Error('Action de diagramme inconnue.');
    }
    send({ id, epoch: requestedEpoch, ok: true, value });
  } catch (error) {
    send({ id, epoch: requestedEpoch, ok: false, error: error?.message || 'Le diagramme n’a pas pu être préparé.' });
  }
});
window.addEventListener('pagehide', () => editor?.destroy());
send({ event: 'ready' });
