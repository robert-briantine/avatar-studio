import type { GenerateOptions } from "./types.js";

function lower(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function creatureConstraint(scenePrompt: string): string {
  const p = lower(scenePrompt);

  if (/\b(demon|demons|demonic|demoniaque|demoniaque|diable|devil)\b/.test(p)) {
    return [
      "The main subject must be an unmistakably NON-HUMAN DEMONIC CREATURE, not a normal human, not a man in costume and not cosplay.",
      "Give it clearly supernatural anatomy and species-defining features: monstrous non-human facial structure, horns or bony protrusions, abnormal skin or scales, claws, fangs, glowing or unnatural eyes, powerful inhuman proportions.",
      "Do not humanize the demon. No ordinary human face, no normal human skin, no ordinary male or female body."
    ].join(" ");
  }

  if (/\b(troll|trolls)\b/.test(p)) {
    return [
      "The main subject must be a clearly NON-HUMAN FANTASY TROLL, not an ordinary human.",
      "Use massive inhuman proportions, rough stone-like or leathery skin, heavy brow, broad jaw, tusks or oversized teeth, huge hands and a monstrous silhouette.",
      "No normal human face, no ordinary man, no cosplay."
    ].join(" ");
  }

  if (/\b(dragon|dragons)\b/.test(p)) {
    return [
      "The main subject must be a true NON-HUMAN DRAGON: reptilian anatomy, scales, elongated skull and muzzle, claws, tail and clearly draconic body proportions.",
      "If wings are appropriate, they must be anatomical dragon wings.",
      "No humanoid dragon, no human face, no person in armor, no ordinary human."
    ].join(" ");
  }

  if (/\b(goblin|goblins)\b/.test(p)) {
    return [
      "The main subject must be a clearly NON-HUMAN GOBLIN with unmistakable fantasy anatomy: pointed ears, unusual skin, sharp teeth, long fingers, compact inhuman proportions and a goblin facial structure.",
      "No normal human face, no ordinary child or adult, no cosplay."
    ].join(" ");
  }

  if (/\b(ghost|spirit|specter|spectre|esprit|fantome|fantome)\b/.test(p)) {
    return [
      "The main subject must look unmistakably supernatural and non-human: translucent or incorporeal body, unnatural silhouette, spectral light and non-ordinary anatomy.",
      "Do not render it as a normal living person."
    ].join(" ");
  }

  return "";
}

export function buildNegativePrompt(scenePrompt: string): string {
  // Official Qwen-Image-2512 ComfyUI negative prompt.
  // Keep this in Chinese exactly like the official template, then append minimal
  // creature-specific negatives when the user clearly asks for a non-human subject.
  const base = "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲";
  const p = lower(scenePrompt);

  if (/\b(demon|demons|demonic|demoniaque|diable|devil|troll|trolls|dragon|dragons|goblin|goblins|ghost|spirit|specter|spectre|esprit|fantome|creature|monster|monstre)\b/.test(p)) {
    return base + ", human, ordinary man, ordinary woman, cosplay, costume, human face, normal human skin, anthropomorphic human face, realistic human portrait";
  }

  if (/\b(robot|robots|android|androide|cyborg|mecha|mechanical)\b/.test(p)) {
    return base + ", human skin, ordinary human portrait, flesh face, realistic human skin";
  }

  if (/\b(animal|animals|wolf|cat|dog|fox|dragon|lion|tiger|bear|bird|eagle|serpent|snake|creature)\b/.test(p)) {
    return base + ", ordinary human, human face, cosplay, person in costume";
  }

  return base;
}

export type VisualPreset = "none" | "scientific-blue";

export function applyVisualPreset(scenePrompt: string, preset: VisualPreset = "none"): string {
  const scene = scenePrompt.trim();
  if (preset !== "scientific-blue") return scene;

  return [
    scene,
    "",
    "VISUAL DIRECTION — SCIENTIFIC BLUE:",
    "Premium scientific editorial visualization on a near-black background.",
    "Restrained electric-blue and cyan palette, very fine luminous technical linework, subtle grids, precise geometry and controlled glow.",
    "High-end physics / mathematics / AI research infographic aesthetic: rigorous, elegant, meticulously detailed, dense but intentionally structured.",
    "Deep blacks, crisp edges, thin vector-like strokes, strong hierarchy, balanced spacing and polished professional rendering.",
    "Keep the requested subject and scene dominant.",
    "Do not invent unrelated equations, labels, panels, objects or scientific symbols unless the scene prompt asks for them.",
    "No random text, no pseudo-writing, no watermark."
  ].join("\n");
}

export function buildBasePrompt(o: GenerateOptions): string {
  const scene = o.scenePrompt.trim();
  const creature = creatureConstraint(scene);

  const quality = [
    "Preserve the requested subject, scene, composition and visual style exactly.",
    "High visual fidelity, coherent composition, meticulous fine details, clean edges, rich natural textures, physically plausible lighting, controlled contrast, sharp important subjects, polished professional finish.",
    "Avoid random objects, unrelated subjects, collage-like artifacts, visual noise and accidental surrealism unless explicitly requested."
  ].join(" ");

  if (o.textMode === "integrated" && o.text.trim()) {
    return `${scene}

${quality}${creature ? `

${creature}` : ""}

Render exactly this visible text, with correct spelling and punctuation: "${o.text.trim()}". Do not add any other words.`;
  }

  if (o.textMode === "exact" && o.text.trim()) {
    return `${scene}

${quality}${creature ? `

${creature}` : ""}

Do not render letters, words, captions, logos or watermarks. Leave enough clean space for a title that will be overlaid later.`;
  }

  return `${scene}

${quality}${creature ? `

${creature}` : ""}`;
}

export function buildStylePrompt(
  o: GenerateOptions,
  hasStyleReference = true,
  visualPreset: VisualPreset = "none"
): string {
  const preserveText = o.textMode === "integrated" && o.text.trim()
    ? `Preserve the existing text exactly as written: "${o.text.trim()}". Do not change, translate, misspell or add text.`
    : "Do not add text, letters, captions, logos or watermarks.";

  const instructions = [
    "Image 1 is the approved base image. Preserve its subject identity, scene, composition, anatomy, geometry, camera angle and object placement.",
    "Refine the image into a polished professional result: improve micro-details, local contrast, lighting coherence, edge cleanliness, depth, geometric precision and visual hierarchy.",
    "Remove small generation artifacts without redesigning the scene.",
    "Do not add unrelated objects or change the meaning of the scene."
  ];

  if (visualPreset === "scientific-blue") {
    instructions.push(
      "Apply the Scientific Blue visual language: near-black background, restrained electric-blue/cyan palette, thin luminous technical linework, subtle grids, precise geometry, deep blacks, controlled glow and very clean detail.",
      "Make the result feel like a premium scientific editorial infographic or research visualization.",
      "Keep all visual information deliberately structured and readable.",
      "Do not invent random equations, fake labels, pseudo-text or unrelated scientific panels."
    );
  }

  if (hasStyleReference) {
    instructions.push(
      "Image 2 is a STYLE REFERENCE ONLY.",
      "Use only its visual language: palette, lighting, contrast, texture, material treatment, brushwork or photographic rendering.",
      "Do not copy people, objects, text, logos, composition or geometry from image 2."
    );
  }

  instructions.push(preserveText);
  return instructions.join(" ");
}

