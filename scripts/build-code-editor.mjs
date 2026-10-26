import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'public/editor-assets');
const inputs = ['package-lock.json', 'scripts/build-code-editor.mjs', 'scripts/editor/code-editor.js', 'src/codeHighlight.ts',
  'scripts/editor/diagram-editor.js', 'src/diagramModel.ts'];
const hash = createHash('sha256');
for (const input of inputs) hash.update(await fs.readFile(path.join(root, input)));
const digest = hash.digest('hex');
try {
  const manifest = JSON.parse(await fs.readFile(path.join(outdir, 'manifest.json'), 'utf8'));
  if (manifest.hash === digest) {
    await Promise.all(manifest.files.map(file => fs.access(path.join(outdir, file))));
    process.exit(0);
  }
} catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }

const result = await build({
  absWorkingDir: root,
  entryPoints: {
    'code-editor': 'scripts/editor/code-editor.js',
    'diagram-editor': 'scripts/editor/diagram-editor.js',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
    'ts.worker': 'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'
  },
  outdir, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, loader: { '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'external', write: false
});
await fs.mkdir(outdir, { recursive: true });
async function publish(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, contents); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
for (const file of result.outputFiles) await publish(file.path, file.contents);
const extraFiles = [];
const apollonAssets = path.join(root, 'node_modules/@tumaet/apollon/dist/assets');
for (const name of await fs.readdir(apollonAssets)) {
  if (!name.includes('.worker-') || !name.endsWith('.js')) continue;
  const relative = `assets/${name}`;
  await publish(path.join(outdir, relative), await fs.readFile(path.join(apollonAssets, name)));
  extraFiles.push(relative);
}
await publish(path.join(outdir, 'resvg.wasm'), await fs.readFile(path.join(root, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));
extraFiles.push('resvg.wasm');
await publish(path.join(outdir, 'licenses/Apollon-Inter.txt'), await fs.readFile(path.join(root, 'node_modules/@tumaet/apollon/dist/LICENSE-InterFont')));
extraFiles.push('licenses/Apollon-Inter.txt');
await publish(path.join(outdir, 'manifest.json'), JSON.stringify({
  hash: digest, files: [...result.outputFiles.map(file => path.relative(outdir, file.path)), ...extraFiles]
}));
console.log('Éditeurs TypeScript et Apollon, exports et workers construits localement.');
