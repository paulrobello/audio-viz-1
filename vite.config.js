import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [glsl(), viteSingleFile()],
  build: { target: 'es2020' },
});
