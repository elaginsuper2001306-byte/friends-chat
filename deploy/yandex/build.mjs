// Builds the Cloud Functions deployment package: app sources + production Node deps.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, 'deploy/yandex/.build');
const output = join(root, 'deploy/yandex/friends-chat.zip');

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

for (const [source, target] of [
  ['deploy/yandex/index.cjs', 'index.cjs'],
  ['web', 'web'],
  ['functions', 'functions'],
  ['server', 'server'],
]) {
  await cp(join(root, source), join(work, target), { recursive: true });
}

await writeFile(join(work, 'package.json'), JSON.stringify({
  name: 'friends-chat-function',
  private: true,
  type: 'module',
  dependencies: { pg: '^8.23.1' },
}, null, 2));

execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts', {
  cwd: work,
  stdio: 'inherit',
});

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(work, full).split('\\').join('/');
    if (rel.startsWith('node_modules/.bin')) continue;
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push([rel, full]);
  }
  return files;
}

const zip = new JSZip();
for (const [name, file] of await walk(work)) zip.file(name, await readFile(file));
const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
await writeFile(output, buffer);

const info = await stat(output);
console.log(`package: ${output}`);
console.log(`size: ${(info.size / 1024 / 1024).toFixed(2)} MB`);
