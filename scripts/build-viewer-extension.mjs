import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildSync, transformSync } from 'esbuild';
import { validateApiOrigin } from './build-extension.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function buildViewerExtension({ apiUrl = 'https://streamlore.patrickvaldivia123.workers.dev', localTest = false, outputDir = resolve(root, 'dist-viewer-extension'), archivePath = resolve(root, 'release/streamlore-viewer.zip') } = {}) {
  const apiOrigin = validateApiOrigin(apiUrl, localTest);
  const staging = mkdtempSync(join(tmpdir(), 'streamlore-viewer-'));
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'viewer-extension/manifest.json'), 'utf8'));
    manifest.host_permissions = [`${apiOrigin}/*`];
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const name of ['background.js', 'popup.html', 'popup.css', 'popup.js']) cpSync(join(root, 'viewer-extension', name), join(staging, name));
    cpSync(join(root, 'public/assets/streamlore-logo.png'), join(staging, 'logo.png'));
    buildSync({ entryPoints: [join(root, 'viewer-extension/content.js')], outfile: join(staging, 'content.js'), bundle: true, format: 'iife', target: 'chrome120', logLevel: 'silent' });
    writeFileSync(join(staging, 'chat-questions.js'), transformSync(readFileSync(join(root, 'shared/chat-questions.ts'), 'utf8'), { loader: 'ts', format: 'esm', target: 'chrome120' }).code);
    writeFileSync(join(staging, 'config.js'), `// Public connection settings only.\nexport const apiOrigin = ${JSON.stringify(apiOrigin)};\nexport const viewerCookie = '__Host-streamlore-viewer';\n`);
    writeFileSync(join(staging, 'README.txt'), 'StreamLore personal viewer add-on\n\n1. Unzip this folder.\n2. Open chrome://extensions, enable Developer mode, choose Load unpacked, and select this folder.\n3. Open StreamLore in the browser toolbar and connect your Twitch account.\n4. Enable lore Whispers. In xQc chat ask "whats a juicer?" or in Caedrel chat ask "What is Sally?".\n\nNo streamer installation is required for the personal add-on. It sends only your own submitted lore questions and the current channel. The cookies API is used only for StreamLore backend cookies; the code never reads Twitch cookies. Twitch may filter Whispers and limits the sender to 40 new recipients per day. This is an unpacked development build, not a Chrome Web Store listing.\n');
    mkdirSync(dirname(archivePath), { recursive: true });
    execFileSync('python3', ['-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as z:\n for p in sorted(root.rglob("*")):\n  if p.is_file(): z.write(p,p.relative_to(root).as_posix())', staging, archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    rmSync(outputDir, { recursive: true, force: true }); mkdirSync(outputDir, { recursive: true }); cpSync(staging, outputDir, { recursive: true });
    return { apiOrigin, outputDir, archivePath };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--api-url' && args[i + 1]) options.apiUrl = args[++i];
      else if (args[i] === '--local-test') options.localTest = true;
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    console.log(buildViewerExtension(options));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
