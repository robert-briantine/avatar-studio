import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import typescript from "shiki/langs/typescript.mjs";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";

export const codeThemes = ["dark-plus", "light-plus"] as const;
export type CodeTheme = typeof codeThemes[number];

export function isCodeTheme(value: unknown): value is CodeTheme {
  return codeThemes.some(theme => theme === value);
}

// The browser and PNG renderer load the same TextMate grammar and VS Code themes.
// Inline WASM keeps both uses local, including when the application is offline.
let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export function getCodeHighlighter() {
  return highlighter ??= createHighlighterCore({
    langs: [typescript], themes: [darkPlus, lightPlus],
    engine: createOnigurumaEngine(import("shiki/wasm"))
  });
}
