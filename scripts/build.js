import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/server.js'], outfile: 'dist/server.js', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: true });
await cp('src/views', 'dist/views', { recursive: true });
await cp('public', 'dist/public', { recursive: true });
console.log('Production SSR build written to dist.');
