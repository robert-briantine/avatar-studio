import sharp from "sharp";
import { getCodeHighlighter, isCodeTheme, type CodeTheme } from "./codeHighlight.js";

export const MAX_RESOURCE_CODE_LENGTH = 20_000;
export class CodeRenderError extends Error {
  readonly status = 400;
}

export function resourceCodeTheme(value: unknown): CodeTheme {
  if (value === undefined) return "dark-plus";
  if (!isCodeTheme(value)) throw new CodeRenderError("Choisissez un thème de code valide : sombre ou clair.");
  return value;
}

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
}[char]!));

function characterColumns(char: string): number {
  if (/[\p{Mark}\u200c\u200d]/u.test(char)) return 0;
  const point = char.codePointAt(0)!;
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
    || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
    || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
    || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
    || point >= 0x1f300 && point <= 0x1faff || point >= 0x20000) ? 2 : 1;
}

function tooDense(): never {
  throw new CodeRenderError("Le code est trop large ou trop long pour un visuel lisible. Raccourcissez les lignes ou répartissez le code entre plusieurs ressources.");
}

/** Render source text only: TypeScript is tokenized, never evaluated. */
export async function resourceCodeSvg(input: unknown, themeInput?: unknown, tight = false): Promise<string> {
  if (typeof input !== "string" || !input.trim()) throw new CodeRenderError("Saisissez du code TypeScript pour afficher l’aperçu.");
  if (input.length > MAX_RESOURCE_CODE_LENGTH) throw new CodeRenderError("Le code est limité à 20 000 caractères.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(input)) {
    throw new CodeRenderError("Le code contient un caractère de contrôle non affichable.");
  }
  const theme = resourceCodeTheme(themeInput);
  const highlighter = await getCodeHighlighter();
  const { tokens, fg, bg } = highlighter.codeToTokens(input, { lang: "typescript", theme });
  // Expand tabs for display only. The persisted source retains its original bytes.
  const lines = tokens.map(line => {
    let column = 0;
    return line.map(token => {
      const content = Array.from(token.content, char => {
        if (char === "\t") { const spaces = 4 - column % 4; column += spaces; return " ".repeat(spaces); }
        column += characterColumns(char); return char;
      }).join("");
      return { ...token, content, endColumn: column };
    });
  });
  const columns = Math.max(1, ...lines.map(line => line.at(-1)?.endColumn ?? 0));
  const width = 1472, height = 1104, margin = 64, advance = 0.6021;
  const lineFit = (height - margin * 2) / (lines.length * 1.5);
  if (Math.min((width - margin * 2) / (columns * advance), lineFit) < 14) tooDense();
  // Pango and librsvg share font fallback. Measure Unicode glyphs too, rather than
  // assuming that every character occupies one cell in DejaVu Sans Mono.
  const measured = await Promise.all(lines.map(async line => {
    const text = line.map(token => token.content).join("");
    if (!text.trim()) return 0;
    return (await sharp({ text: { text: escape(text), font: "DejaVu Sans Mono 32", dpi: 72 } }).metadata()).width ?? 0;
  }));
  const textWidth = Math.max(columns * advance * 32, ...measured) + 8;
  const fontSize = Math.min(32, (width - margin * 2) / textWidth * 32, lineFit);
  if (fontSize < 14) tooDense();
  const content = lines.map((line, index) => {
    const y = margin + fontSize + index * fontSize * 1.5;
    const spans = line.map(token => {
      const style = token.fontStyle ?? 0;
      return `<tspan fill="${token.color || fg}"${style & 1 ? ' font-style="italic"' : ""}${style & 2 ? ' font-weight="bold"' : ""}${style & 4 ? ' text-decoration="underline"' : ""}>${escape(token.content)}</tspan>`;
    }).join("");
    return `<text x="${margin}" y="${y}">${spans}</text>`;
  }).join("");
  const renderedWidth = tight ? Math.ceil(textWidth * fontSize / 32 + margin * 2) : width;
  const renderedHeight = tight ? Math.ceil(lines.length * fontSize * 1.5 + margin * 2) : height;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${renderedWidth}" height="${renderedHeight}" viewBox="0 0 ${renderedWidth} ${renderedHeight}"><rect width="100%" height="100%" fill="${bg}"/><g font-family="DejaVu Sans Mono, monospace" font-size="${fontSize}" font-variant-ligatures="none" xml:space="preserve">${content}</g></svg>`;
}

export async function renderResourceCode(source: unknown, theme?: unknown): Promise<Buffer> {
  return sharp(Buffer.from(await resourceCodeSvg(source, theme))).png().toBuffer();
}

/** Preserve all source lines and indentation while fitting the theme panel to the excerpt. */
export async function renderResourceCodeContent(source: unknown, theme?: unknown): Promise<Buffer> {
  return sharp(Buffer.from(await resourceCodeSvg(source, theme, true))).png().toBuffer();
}
