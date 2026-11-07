/**
 * Builds the game into a folder (default dist/):
 *   index.html   page with inlined styles
 *   game.js      bundled + minified code (models and map data embedded)
 *   ...          everything in public/ (textures, sounds, extra models), copied as is
 *
 *   node build.mjs              production build into dist/
 *   node build.mjs --dev        unminified with inline source maps
 *   node build.mjs --out DIR    build into another folder (used by parallel work and tests)
 */
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : 'dist';

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  format: 'iife',
  target: 'es2020',
  write: false,
  loader: { '.gz': 'binary', '.glb': 'binary' },
  legalComments: 'none',
  logLevel: 'warning',
});
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'game.js'), result.outputFiles[0].text);
const css = fs.readFileSync('src/ui/styles.css', 'utf8');
const html = fs
  .readFileSync('src/index.html', 'utf8')
  .replace('/*STYLES*/', () => css)
  .replace(/<script>\s*\/\*GAME\*\/\s*<\/script>/, () => '<script src="game.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
if (fs.existsSync('public')) fs.cpSync('public', out, { recursive: true });

let total = 0;
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
};
walk(out);
console.log(`${out}/ built · ${(total / 1e6).toFixed(1)} MB total`);
