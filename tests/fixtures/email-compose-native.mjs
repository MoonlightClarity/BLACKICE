/** Hidden, isolated Chromium UI fixture. No real account, provider, or mail process. */
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv.find(arg => arg.startsWith('--fixture-data='))?.slice('--fixture-data='.length);
assert.ok(directory && path.isAbsolute(directory));
app.setPath('userData', path.join(directory, 'owned-profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const report = { fixtureOnly: true, liveMailRequests: 0, foregroundWindows: 0, checks: [] };
let server, window;
async function run() {
try {
  await app.whenReady();
  const index = await fs.readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const styles = [...index.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map(item => item[0]).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="modal-root" class="modal-root"></div><script type="module">
    import { initEmailUI } from '/email-ui.mjs';
    window.calls=[]; const saved=new Map(); window.mode='sent';
    const api=async(url,request={})=>{window.calls.push({url,method:request.method||'GET',body:request.body});
      if(url==='/api/email')return {revision:1,configured:true,enabled:true,config:{enabled:true,account:'fixture',executable:'/fixture/mail',configPath:'/fixture/config'},cli:{checked:true},drafts:[],capabilities:{compose:true,send:true}};
      if(url==='/api/email/client')return {available:false};
      if(url==='/api/email/deliveries')return {deliveries:[...saved.values()]};
      if(url.startsWith('/api/email/deliveries/'))return {delivery:saved.get(url.split('/').at(-1))};
      if(url==='/api/email/compose'){const item={...request.body,id:'fixture-'+(saved.size+1),state:'prepared',sent:false,transportAccepted:false,attachments:request.body.attachments.map(()=>({fileName:'résumé.pdf',size:2048,contentType:'application/pdf',sha256:'a'.repeat(64)}))};saved.set(item.id,item);return {delivery:item};}
      if(url==='/api/email/send'){const item=saved.get(request.body.id);Object.assign(item,{state:window.mode,sent:window.mode==='sent',transportAccepted:window.mode==='sent'});return {delivery:item};}
      throw Error('Unexpected fixture request');
    };
    window.ui=initEmailUI({api,pickFiles:async()=>['C:\\\\fixture\\\\résumé.pdf'],showModal(_id,html){document.querySelector('#modal-root').innerHTML='<div class="modal-backdrop"><section class="modal wide" role="dialog" aria-modal="true" aria-label="Email">'+html+'</section></div>';document.querySelector('#modal-root').hidden=false;}});
    window.ready=window.ui.open();
  </script>`;
  server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
      const file = path.resolve(publicRoot, `.${pathname}`);
      if (!file.startsWith(publicRoot) || !/\.(?:mjs|css|svg|png|webp|woff2?)$/.test(file)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  assert.equal(window.isVisible(), false);
  report.foregroundWindows = BrowserWindow.getAllWindows().filter(item => item.isVisible()).length;
  window.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('data:') }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL(origin); await window.webContents.executeJavaScript('window.ready');
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (const width of [1440, 390, 320]) {
    window.setContentSize(width, 900);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const layout = await evaluate(`(()=>{const pane=document.querySelector('#email-workspace'),form=document.querySelector('#email-draft-form');const controls=[...form.querySelectorAll('input,textarea,button')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]')).map(el=>{const r=el.getBoundingClientRect();return{id:el.id,left:r.left,right:r.right,width:r.width,height:r.height}});return{width:innerWidth,client:pane.clientWidth,scroll:pane.scrollWidth,controls,firstSection:pane.querySelector('section')?.className}})()`);
    assert.ok(layout.scroll <= layout.client + 2, JSON.stringify(layout));
    assert.equal(layout.firstSection, 'email-compose');
    assert.ok(layout.controls.every(item => item.left >= -1 && item.right <= width + 1 && item.width >= 36 && item.height >= 36), JSON.stringify(layout));
    report.checks.push({ name: `Contained composer fits ${width}px with labeled usable controls`, layout });
    await evaluate(`document.querySelector('#email-workspace').scrollTop=0`);
    await fs.writeFile(path.join(directory, `composer-${width}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await evaluate(`document.querySelector('#email-send').click()`);
  assert.equal(await evaluate(`window.calls.filter(item=>item.method==='POST').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#email-from').validity.valueMissing`), true);
  report.checks.push({ name: 'Real required sender validation stops an incomplete send' });
  await evaluate(`(()=>{for(const [id,value]of Object.entries({from:'writer@example.test',to:'recipient@example.test',cc:'',bcc:'',subject:'Fixture message',body:'Fixture body'})){const el=document.querySelector('#email-'+id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))}return document.querySelector('#email-attachment-choose').onclick()})()`);
  await evaluate(`document.querySelector('#email-send').onclick()`);
  const sent = await evaluate(`({calls:window.calls.filter(item=>item.method==='POST'),status:document.querySelector('#email-send-status').textContent,disabled:document.querySelector('#email-send').disabled,attachment:document.querySelector('#email-compose-attachments').textContent,storage:localStorage.getItem('blackice.email.pending-delivery.v1')})`);
  assert.deepEqual(sent.calls.map(item => item.url), ['/api/email/compose', '/api/email/send']);
  assert.deepEqual(sent.calls[0].body.attachments, ['C:\\fixture\\résumé.pdf']);
  assert.match(sent.status, /^Sent\..*Recipient receipt has not been confirmed/); assert.equal(sent.disabled, true); assert.match(sent.attachment, /2 KB/); assert.doesNotMatch(sent.storage, /writer@|recipient@|Fixture body|résumé|fixture\\/);
  report.checks.push({ name: 'One ordinary Send composes exact chosen file and sends once with accurate service acceptance' });
  await evaluate(`document.querySelector('#email-draft-new').onclick();window.mode='uncertain';for(const[id,value]of Object.entries({from:'writer@example.test',to:'recipient@example.test',subject:'Uncertain fixture',body:'Body'})){const el=document.querySelector('#email-'+id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))}document.querySelector('#email-send').scrollIntoView()`);
  await evaluate(`document.querySelector('#email-send').onclick()`);
  assert.match(await evaluate(`document.querySelector('#email-send-status').textContent`), /^Delivery uncertain/);
  assert.equal(await evaluate(`document.querySelector('#email-send').disabled`), true);
  await evaluate(`document.querySelector('#email-send-status').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await fs.writeFile(path.join(directory, 'composer-uncertain-320.png'), (await window.webContents.capturePage()).toPNG());
  report.checks.push({ name: 'Uncertain result remains visible and cannot silently dispatch another copy' });
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack || String(error); }
finally {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  report.closedWindows = BrowserWindow.getAllWindows().length === 0;
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}
}
void run();
