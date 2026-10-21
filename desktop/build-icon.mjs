/* Run with the project's pinned Electron:
 *   electron desktop/build-icon.mjs
 *   electron desktop/build-icon.mjs --check
 * A hidden renderer rasterizes the editable SVG for native packaging only.
 */
import {app, BrowserWindow} from 'electron';
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sizes = [16, 24, 32, 48, 64, 128, 256];
let window;
let phase = 'module-start';
const startedAt = Date.now();
function stage(name) {
  phase = name;
  process.stderr.write(`BLACKICE icon build: ${name} (${Date.now() - startedAt}ms)\n`);
}
app.disableHardwareAcceleration();
const deadline = setTimeout(() => {
  process.stderr.write(`Icon rendering exceeded 30 seconds during ${phase}.\n`);
  window?.destroy();
  app.exit(1);
}, 30_000);

async function atomicWrite(destination, bytes) {
  const temporary = `${destination}.${randomUUID()}.stage`;
  try {
    await writeFile(temporary, bytes, {flag: 'wx'});
    await rename(temporary, destination);
  } finally {
    await rm(temporary, {force: true});
  }
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({size, png}, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

// Electron's ready event follows ESM entry evaluation. Start the asynchronous
// work without top-level awaiting that event, so module loading can complete.
async function main() {
try {
  stage('read-vector-source');
  const source = await readFile(path.join(directory, 'icon.svg'));
  const svg = source.toString('utf8');
  if (!/<svg\b/.test(svg) || /<image\b|<script\b|<foreignObject\b|\bhref\s*=|@import|data:/i.test(svg)) {
    throw new Error('The icon source must contain self-contained vector geometry.');
  }
  stage('wait-for-electron-ready');
  await app.whenReady();
  stage('create-hidden-renderer');
  window = new BrowserWindow({
    show: false, width: 512, height: 512, frame: false,
    webPreferences: {offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `blackice-icon-${randomUUID()}`},
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`BLACKICE icon renderer exited during ${phase}: ${details.reason}\n`);
  });
  window.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'file://*/*']}, (_request, callback) => callback({cancel: true}));
  stage('load-empty-document');
  await window.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3EBLACKICE%20icon%20renderer%3C%2Ftitle%3E');
  stage('decode-and-rasterize-svg');
  const rendered = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    await image.decode();
    return ${JSON.stringify([...sizes, 512])}.map(size => {
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const context = canvas.getContext('2d', {alpha: true});
      context.clearRect(0, 0, size, size); context.drawImage(image, 0, 0, size, size);
      return {size, png: canvas.toDataURL('image/png').split(',')[1]};
    });
  })()`);
  const images = rendered.map(({size, png}) => ({size, png: Buffer.from(png, 'base64')}));
  const master = images.find(image => image.size === 512).png;
  const ico = encodeIco(images.filter(image => image.size !== 512));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1, source: 'icon.svg', sourceSha256: sha256(source),
    renderer: {electron: process.versions.electron, chromium: process.versions.chrome},
    pngSha256: sha256(master), icoSha256: sha256(ico), sizes,
  }, null, 2) + '\n');
  const outputs = [
    [path.join(directory, 'blackice-icon.png'), master],
    [path.join(directory, 'icon.ico'), ico],
    [path.join(directory, 'icon.manifest.json'), manifest],
    [path.resolve(directory, '../public/assets/relay-mark.svg'), source],
  ];
  stage(check ? 'check-derived-files' : 'write-derived-files');
  for (const [destination, bytes] of outputs) {
    if (check) {
      if (!(await readFile(destination)).equals(bytes)) throw new Error(`${path.basename(destination)} differs from the editable SVG render; run the icon build.`);
    } else await atomicWrite(destination, bytes);
  }
  stage('complete');
  process.stdout.write(JSON.stringify({ok: true, check, sourceSha256: sha256(source), sizes, nativeFiles: ['blackice-icon.png', 'icon.ico', 'icon.manifest.json']}) + '\n');
} catch (error) {
  process.stderr.write(`BLACKICE icon build failed during ${phase}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  window?.destroy();
  app.exit(process.exitCode || 0);
}
}

void main();
