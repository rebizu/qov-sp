import { defineConfig } from 'vite';
import { resolve } from 'path';


export default defineConfig({
  plugins: [],
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
      },
    },
  },
});
