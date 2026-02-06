import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    '@elizaos/core',
    '@elizaos/plugin-bootstrap',
    '@elizaos/plugin-sql',
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-telegram',
    '@elizaos/plugin-knowledge',
  ],
});
