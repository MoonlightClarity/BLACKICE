import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

test('the production server serves every stylesheet and script linked by the Next entry page', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-next-assets-'));
  const dataDir = path.join(root, 'data'); await mkdir(dataDir);
  const transport = createRemoteTransportFixture();
  const remoteAccess = new RemoteAccessManager({ dataDir, transport: transport.transport, defaultHttpsPort: 8443 });
  const runtime = new EventEmitter();
  runtime.status = () => ({ connected: false, authenticated: false, models: [] });
  runtime.start = async () => runtime.status(); runtime.close = async () => {};
  runtime.runAgent = async () => assert.fail('Entry asset delivery must never start a model.');
  const desktop = new EventEmitter();
  desktop.status = () => ({ available: false, enabled: false });
  desktop.setEnabled = async () => desktop.status();
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(root, 'workspace'), runtime, desktop, remoteAccess, autoAttachDesktop: false });
  const base = await app.listen();
  const entry = await fetch(base + '/next/');
  assert.equal(entry.status, 200);
  const cookie = entry.headers.get('set-cookie').split(';')[0], html = await entry.text();
  const assets = [...new Set([...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)=["'](\/[^"']+)["']/g)].map(match => match[1]))];
  assert.ok(assets.some(url => new URL(url, base).pathname === '/next/layout-fixes.css'));
  assert.ok(assets.some(url => new URL(url, base).pathname === '/next/planning-ontology.css'));
  const failures = [];
  for (const url of assets) {
    const response = await fetch(base + url, { headers: { Cookie: cookie } });
    const text = await response.text(), pathname = new URL(url, base).pathname;
    const expected = pathname.endsWith('.css') ? 'text/css' : /\.m?js$/.test(pathname) ? 'text/javascript' : 'image/svg+xml';
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith(expected) || !text.trim()) {
      failures.push({ url, status: response.status, contentType: response.headers.get('content-type') });
    }
  }
  // Traverse actual static and lazy module imports through the production
  // handler, rather than checking only that imported files exist on disk.
  const modules=[...new Set(assets.filter(url=>/\.m?js$/.test(new URL(url,base).pathname)))];
  const visited=new Set(),critical=[];
  for(const route of ['/next/core/workspace-navigation.mjs','/next/workspaces/settings-passwords.mjs','/next/settings-passwords.css','/browser-credentials-ui.mjs','/browser-credentials.css']){
    const response=await fetch(base+route,{headers:{Cookie:cookie}});
    const content=await response.text(),expected=route.endsWith('.css')?'text/css':'text/javascript';
    critical.push({route,status:response.status,contentType:response.headers.get('content-type'),bytes:Buffer.byteLength(content)});
    if(response.status!==200||!response.headers.get('content-type')?.startsWith(expected)||!content.trim())failures.push(critical.at(-1));
  }
  while(modules.length){
    const route=modules.shift();if(visited.has(route))continue;visited.add(route);
    const response=await fetch(base+route,{headers:{Cookie:cookie}});
    const content=await response.text();
    if(response.status!==200||!response.headers.get('content-type')?.startsWith('text/javascript')){
      failures.push({route,status:response.status,contentType:response.headers.get('content-type')});continue;
    }
    for(const match of content.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)){
      const specifier=match[1];if(!specifier.startsWith('.')&&!specifier.startsWith('/'))continue;
      const target=new URL(specifier,new URL(route,base));
      if(target.origin===new URL(base).origin&&!visited.has(target.pathname))modules.push(target.pathname);
    }
  }
  const denied=await fetch(base+'/next/not-a-registered-asset.mjs',{headers:{Cookie:cookie}});
  assert.equal(denied.status,404,'Static registration must not become an unrestricted filesystem server.');
  t.diagnostic(JSON.stringify({critical,reachableModules:visited.size}));
  assert.deepEqual(failures, [], 'Entry and reachable import assets must load through production routing, not only the permissive UI fixture server.');
  t.diagnostic(JSON.stringify({ assets: assets.length, stylesheetQueryStringsPreserved: assets.some(url => url.includes('.css?')) }));
});
