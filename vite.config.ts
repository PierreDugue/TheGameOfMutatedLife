import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site from /TheGameOfMutatedLife/; dev server stays at /.
  base: process.env.GITHUB_ACTIONS ? '/TheGameOfMutatedLife/' : '/',
  build: { target: 'es2022' },
});
