import { defineConfig } from 'vite';

// asset-manifest.json lists every build file; the Service Worker (public/sw.js) precaches them for offline use.
// Not under .vite/: some static hosts don't serve dot-folders.
export default defineConfig({ build: { manifest: 'asset-manifest.json' } });
