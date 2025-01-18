import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync } from 'fs';


export default defineConfig({
  plugins: [
    {
      name: 'copy-spec-md',
      closeBundle() {
        // Copy the markdown file to dist folder
        copyFileSync(
          resolve(__dirname, 'qov-specification.md'),
          resolve(__dirname, 'dist/qov-specification.md')
        );
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
      },
    },
  },
});
