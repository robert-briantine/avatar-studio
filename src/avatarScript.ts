export type AvatarScriptDisplay =
  | { mode: "standard" }
  | { mode: "text" | "latex" | "image" | "file" | "ref"; content: string };

export type AvatarScriptSequence = AvatarScriptDisplay & { text: string };

export type AvatarScript = {
  source: string;
  narration: string;
  sequences: AvatarScriptSequence[];
};

/** Measured bounds in the concatenated narration WAV, in seconds. */
export type AvatarScriptTiming = { sequenceIndex: number; start: number; end: number };

export function hasScriptOverlays(script: AvatarScript): boolean {
  return script.sequences.some(sequence => sequence.mode === "text" || sequence.mode === "latex");
}

export function hasScriptImages(script: AvatarScript): boolean {
  return script.sequences.some(sequence => sequence.mode === "image");
}

export function hasScriptReferences(script: AvatarScript): boolean {
  return script.sequences.some(sequence => sequence.mode === "ref");
}

export function hasScriptVisuals(script: AvatarScript): boolean {
  return hasScriptOverlays(script) || hasScriptImages(script) || hasScriptReferences(script) || script.sequences.some(sequence => sequence.mode === "file");
}

export class AvatarScriptSyntaxError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} (caractère ${position + 1}).`);
    this.name = "AvatarScriptSyntaxError";
  }
}

const commandModes = new Map<string, "text" | "latex" | "image" | "file" | "ref">([
  ["Texte", "text"], ["Latex", "latex"], ["Image", "image"], ["File", "file"], ["Ref", "ref"]
]);

/** Parse visual instructions without reading files or generating any media. */
export function parseAvatarScript(source: string): AvatarScript {
  const sequences: AvatarScriptSequence[] = [];
  let display: AvatarScriptDisplay = { mode: "standard" };
  let displayStart = 0;
  let textStart = 0;
  let cursor = 0;

  const appendText = (end: number) => {
    const text = source.slice(textStart, end).replace(/\\([{}\\])/g, "$1").trim();
    if (text) sequences.push({ ...display, text });
    else if (display.mode !== "standard") {
      throw new AvatarScriptSyntaxError("La commande visuelle doit être suivie d’un texte à prononcer", displayStart);
    }
  };

  while (cursor < source.length) {
    if (source[cursor] === "\\" && /[{}\\]/.test(source[cursor + 1] || "")) {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "}") {
      throw new AvatarScriptSyntaxError("Accolade fermante sans commande", cursor);
    }
    if (source[cursor] !== "{") {
      cursor++;
      continue;
    }

    appendText(cursor);
    const start = cursor;
    let depth = 1;
    cursor++;
    while (cursor < source.length && depth > 0) {
      // LaTeX uses nested groups and escaped braces such as \left\{.
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === "{") depth++;
      if (source[cursor] === "}") depth--;
      if (depth > 0) cursor++;
    }
    if (depth > 0) {
      throw new AvatarScriptSyntaxError("Commande sans accolade fermante", start);
    }

    const instruction = source.slice(start + 1, cursor).trim();
    if (!instruction) {
      display = { mode: "standard" };
    } else {
      const separator = instruction.indexOf(":");
      if (separator < 0) {
        throw new AvatarScriptSyntaxError("Commande attendue sous la forme {Commande: contenu}", start);
      }
      const name = instruction.slice(0, separator).trim();
      const mode = commandModes.get(name);
      if (!mode) {
        throw new AvatarScriptSyntaxError(`Commande inconnue : ${name}`, start);
      }
      const content = instruction.slice(separator + 1).trim();
      if (!content) {
        throw new AvatarScriptSyntaxError(`Contenu vide pour la commande ${name}`, start);
      }
      display = { mode, content: mode === "ref" ? content.replace(/\\\\/g, "\\") : content };
      displayStart = start;
    }
    cursor++;
    textStart = cursor;
  }
  appendText(source.length);

  return { source, narration: sequences.map(sequence => sequence.text).join(" "), sequences };
}
