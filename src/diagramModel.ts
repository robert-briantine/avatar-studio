import type { UMLModel } from "@tumaet/apollon/model";

export const diagramTypes = [
  ["Flowchart", "Organigramme"], ["ActivityDiagram", "Activités"], ["ClassDiagram", "Classes UML"],
  ["ObjectDiagram", "Objets UML"], ["UseCaseDiagram", "Cas d’utilisation"],
  ["CommunicationDiagram", "Communication"], ["ComponentDiagram", "Composants"],
  ["DeploymentDiagram", "Déploiement"], ["BPMN", "Processus BPMN"], ["PetriNet", "Réseau de Petri"],
  ["ReachabilityGraph", "Graphe d’accessibilité"], ["SyntaxTree", "Arbre syntaxique"], ["Sfc", "Grafcet (SFC)"]
] as const;

export class DiagramError extends Error { readonly status = 400; }

function diagramId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  // getRandomValues also works when a DGX is opened through its local HTTP address.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function emptyDiagram(type: UMLModel["type"] = "Flowchart"): UMLModel {
  return { version: "4.2.0", id: diagramId(), title: "", type, nodes: [], edges: [], assessments: {} };
}

export function diagramFromText(text: string): UMLModel {
  const labels = text.split(/\s*(?:→|->|\r?\n)\s*/).filter(Boolean);
  if (!labels.length) throw new DiagramError("Saisissez au moins une étape à convertir.");
  if (labels.length > 30 || labels.some(label => label.length > 200)) {
    throw new DiagramError("La conversion accepte jusqu’à 30 étapes de 200 caractères. Raccourcissez le texte avant de le convertir.");
  }
  const model = emptyDiagram();
  model.nodes = labels.map((name, index) => ({
    id: diagramId(), type: "flowchartProcess", position: { x: index % 3 * 280, y: Math.floor(index / 3) * 180 },
    width: 220, height: 90, measured: { width: 220, height: 90 }, data: { name }
  }));
  model.edges = model.nodes.slice(1).map((node, index) => ({
    id: diagramId(), type: "FlowChartFlowline", source: model.nodes[index].id, target: node.id,
    sourceHandle: "right", targetHandle: "left", data: { points: [], name: "" }
  }));
  return model;
}

/** Native models and their references are bounded before entering the graphical editor. */
export function parseDiagramModel(input: unknown): UMLModel {
  if (typeof input !== "string" || !input.trim()) throw new DiagramError("Créez un diagramme dans l’éditeur.");
  if (new TextEncoder().encode(input).length > 1024 * 1024) throw new DiagramError("Le diagramme est limité à 1 Mo.");
  let model: UMLModel;
  try { model = JSON.parse(input); } catch { throw new DiagramError("Ce contenu n’est pas un diagramme Apollon. Utilisez « Convertir le texte » pour reprendre une ancienne description."); }
  if (!model || typeof model !== "object" || !/^4\.\d+\.\d+$/.test(model.version)
    || !diagramTypes.some(([type]) => type === model.type) || !Array.isArray(model.nodes) || !Array.isArray(model.edges)
    || typeof model.id !== "string" || typeof model.title !== "string" || !model.assessments || Array.isArray(model.assessments) || typeof model.assessments !== "object") {
    throw new DiagramError("Modèle Apollon invalide : la version, le type et les données du diagramme sont requis.");
  }
  if (model.nodes.length > 150 || model.edges.length > 300) throw new DiagramError("Un diagramme est limité à 150 éléments et 300 liens. Répartissez les grands schémas entre plusieurs ressources.");
  const ids = new Set<string>();
  const identifier = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(id);
  const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 20_000;
  for (const node of model.nodes) {
    if (!node || !identifier(node.id) || ids.has(node.id) || !coordinate(node.position?.x) || !coordinate(node.position?.y)
      || !coordinate(node.width) || !coordinate(node.height) || node.width <= 0 || node.height <= 0
      || typeof node.type !== "string" || !node.data || typeof node.data !== "object" || Array.isArray(node.data)) {
      throw new DiagramError("Un élément du diagramme est invalide : vérifiez son identifiant, sa position et ses dimensions.");
    }
    ids.add(node.id);
  }
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  for (const node of model.nodes) {
    const ancestors = new Set([node.id]);
    let parent = node.parentId;
    while (parent) {
      if (!nodes.has(parent) || ancestors.has(parent)) throw new DiagramError("Les groupes du diagramme contiennent une référence absente ou circulaire.");
      ancestors.add(parent); parent = nodes.get(parent)!.parentId;
    }
  }
  for (const edge of model.edges) {
    if (!edge || !identifier(edge.id) || ids.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target)
      || typeof edge.type !== "string" || typeof edge.sourceHandle !== "string" || typeof edge.targetHandle !== "string"
      || !edge.data || !Array.isArray(edge.data.points) || edge.data.points.length > 100
      || edge.data.points.some(point => !coordinate(point?.x) || !coordinate(point?.y))) {
      throw new DiagramError("Un lien du diagramme est invalide ou référence un élément absent.");
    }
    ids.add(edge.id);
  }
  return model;
}
