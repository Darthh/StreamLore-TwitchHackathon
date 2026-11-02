import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { buildExtension } from './build-extension.mjs';

const origin = 'https://streamlore.patrickvaldivia123.workers.dev';
buildExtension({ apiUrl: origin });
rmSync('dist-worker', { recursive: true, force: true });
mkdirSync('dist-worker', { recursive: true });
cpSync('dist', 'dist-worker', { recursive: true });
cpSync('dist-extension', 'dist-worker/extension', { recursive: true });
for (const name of ['install.html', 'install.js', 'install.css', 'everywhere.html', 'everywhere.js']) cpSync(`public/${name}`, `dist-worker/${name}`);
mkdirSync('dist-worker/downloads', { recursive: true });
cpSync('release/streamlore-twitch-extension.zip', 'dist-worker/downloads/streamlore-twitch-extension.zip');
console.log(`Worker assets and Twitch ZIP target ${origin}`);
