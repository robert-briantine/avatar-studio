import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import { conf } from 'monaco-editor/languages/definitions/typescript/typescript.js';
import { typescriptDefaults } from 'monaco-editor/language/typescript/monaco.contribution.js';
import { shikiToMonaco } from '@shikijs/monaco';
import { getCodeHighlighter } from '../../src/codeHighlight.ts';

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const file = label === 'typescript' || label === 'javascript' ? 'ts.worker.js' : 'editor.worker.js';
    return new Worker(new URL(file, import.meta.url), { type: 'module' });
  }
};
monaco.languages.register({ id: 'typescript', extensions: ['.ts'], aliases: ['TypeScript'] });
monaco.languages.setLanguageConfiguration('typescript', conf);
typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
const ready = getCodeHighlighter().then(highlighter => shikiToMonaco(highlighter, monaco));

export async function createCodeEditor(container, { source, theme, readOnly, onChange }) {
  await ready;
  const model = monaco.editor.createModel(source, 'typescript');
  const editor = monaco.editor.create(container, {
    model, theme, readOnly, automaticLayout: true,
    ariaLabel: 'Code TypeScript de la ressource',
    fontFamily: 'DejaVu Sans Mono, monospace', fontSize: 16, lineHeight: 24,
    fontLigatures: false, minimap: { enabled: false },
    wordWrap: 'off', scrollBeyondLastLine: false,
    'semanticHighlighting.enabled': false, bracketPairColorization: { enabled: false },
    padding: { top: 12, bottom: 12 }, renderWhitespace: 'selection',
    detectIndentation: false, autoIndent: 'none', formatOnPaste: false, formatOnType: false,
    quickSuggestions: false, unicodeHighlight: { ambiguousCharacters: false }
  });
  // An explicitly supplied model keeps its own bracket-coloring options.
  model.updateOptions({ tabSize: 4, insertSpaces: true,
    bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
  let updating = false;
  function setSource(value) {
    updating = true;
    try {
      if (model.getValue() !== value) model.setValue(value);
      const crlf = value.includes('\r\n') && !value.replaceAll('\r\n', '').includes('\n');
      model.setEOL(crlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    } finally { updating = false; }
  }
  setSource(source);
  editor.onDidChangeModelContent(() => { if (!updating) onChange(model.getValue()); });
  return {
    setSource,
    setTheme(value) { monaco.editor.setTheme(value); },
    setLocked(value) { editor.updateOptions({ readOnly: value }); },
    layout() { editor.layout(); },
    focus() { editor.focus(); },
    dispose() { editor.dispose(); model.dispose(); }
  };
}
