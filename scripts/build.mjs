// Builds the extension into dist/ with Vite (multiple targeted builds) and the local server into dist-server/.
import { build } from 'vite';
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const out = resolve(root, 'dist');
const common = { configFile: false, logLevel: 'warn', define: { 'process.env.NODE_ENV': '"production"' } };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Extension pages (popup, options, offscreen) — ES modules, shared chunks allowed.
await build({
  ...common,
  root: src,
  base: '',
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'chrome116',
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(src, 'popup/popup.html'),
        options: resolve(src, 'settings/options.html'),
        offscreen: resolve(src, 'audio/offscreen.html'),
        dashboard: resolve(src, 'dashboard/dashboard.html'),
      },
      output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});

// 2. Single-file bundles: background (ES module SW), content script (classic IIFE), audio worklet.
const single = [
  { entry: 'background/index.ts', file: 'background.js', format: 'es' },
  { entry: 'content/index.ts', file: 'content.js', format: 'iife' },
  { entry: 'audio/worklet.ts', file: 'audio-worklet.js', format: 'es' },
];
for (const s of single) {
  await build({
    ...common,
    root,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'chrome116',
      sourcemap: false,
      minify: true,
      lib: { entry: resolve(src, s.entry), formats: [s.format], name: 'sst', fileName: () => s.file },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

// 3. Static files.
cpSync(resolve(root, 'public'), out, { recursive: true });
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 4. Local translation/STT server (Node, no runtime deps).
await build({
  ...common,
  root,
  build: {
    outDir: resolve(root, 'dist-server'),
    emptyOutDir: true,
    target: 'node20',
    ssr: true,
    minify: false,
    rollupOptions: { input: resolve(root, 'server/local-server.ts'), output: { format: 'es', entryFileNames: 'local-server.mjs' } },
  },
});

console.log('✓ build complete → dist/ (extension) and dist-server/ (local backend)');
