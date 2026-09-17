import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync } from 'fs';

// Documentation the spec viewer (spec.html?doc=...) fetches at runtime —
// every file here must ship in dist/ for a static deploy to work.
const DOCS = [
  'qov-specification.md',
  'qov-streaming-spec.md',
  'BENCHMARKS.md',
  'CONFERENCE-ROADMAP.md',
  'PFRAME-EXPLORATION.md',
  'README.md',
];

export default defineConfig({
  plugins: [
    {
      name: 'copy-docs',
      closeBundle() {
        for (const doc of DOCS) {
          copyFileSync(resolve(__dirname, doc), resolve(__dirname, 'dist', doc));
        }
      },
    },
  ],
  server: {
    host: true,   // Listen on all addresses
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        recorder: resolve(__dirname, 'recorder.html'),
        player: resolve(__dirname, 'player.html'),
        converter: resolve(__dirname, 'converter.html'),
        spec: resolve(__dirname, 'spec.html'),
        diagnose: resolve(__dirname, 'diagnose.html'),
        call: resolve(__dirname, 'call.html'),
      },
    },
  },
});
