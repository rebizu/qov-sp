import { defineConfig } from 'vite';
import { resolve } from 'path';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
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
        test: resolve(__dirname, 'Fensmark test.qov'),
        test2: resolve(__dirname, 'Fensmark test_comp.qov'),
      },
    },
  },
});
