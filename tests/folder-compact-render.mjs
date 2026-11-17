
import {app,BrowserWindow} from 'electron';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHarnessServer} from '../server.mjs';
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
async function main(){
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'.build/folder-ux');
const temporary=await mkdtemp(path.join(tmpdir(),'blackice-folder-render-'));app.setPath('userData',path.join(temporary,'profile'));await mkdir(out,{recursive:true});
class Runtime extends EventEmitter{
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
 async start(){return this.status();}async close(){}async runAgent(){throw Error('No model calls permitted in fixture');}
}
let server,win;const result={passed:false,checks:[],screenshots:[],errors:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(60);}throw Error('Timed out '+label);};
try{
 server=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(temporary,'data'),defaultCwd:path.join(temporary,'work')});
 const url=await server.listen();const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 const request=async(route,body)=>{const response=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error(route+' '+response.status+' '+await response.text());return response.json();};
 let org=await request('/api/knowledge/folders',{action:'create',name:'Research',expectedRevision:1});const parent=org.folders[0].id;
 org=await request('/api/knowledge/folders',{action:'create',name:'Applications',parentId:parent,expectedRevision:org.revision});const child=org.folders[1].id;
 for(let i=0;i<9;i++){const kind=i<5?'memory':'skill';const entry=await request('/api/knowledge',{kind,title:(kind==='memory'?'Research decision ':'Application procedure ')+(i+1),summary:'This deliberately long summary should stay compact in the list while remaining complete on demand. '.repeat(3),content:'Complete '+kind+' content with details retained for editing and inspection.\nSecond paragraph stays intact.',...(kind==='memory'?{memoryType:'decision'}:{})});org=await request('/api/knowledge/folders',{action:'move',entryIds:[entry.id],folderId:i===0?parent:child,expectedRevision:org.revision});}
 await app.whenReady();win=new BrowserWindow({show:false,width:1360,height:960,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)result.errors.push(message);});
 const run=code=>win.webContents.executeJavaScript(code,true);
 const shot=async name=>{await sleep(250);await writeFile(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());result.screenshots.push(name);};
 await win.loadURL(url+'/next/#knowledge');await until(()=>run("!!document.querySelector('[data-knowledge-id]')"),'memory rows');
 await shot('01-memory-tree-desktop');
 const nested=await run("document.querySelector('[data-folder-id="+JSON.stringify(child)+"]').closest('.next-folder-children')!==null");assert.equal(nested,true);result.checks.push('Memory subfolder visibly nested');
 await run("document.querySelector('[data-folder-id="+JSON.stringify(child)+"]').click()");
 await until(()=>run("document.querySelectorAll('[data-knowledge-id]').length===4"),'child filtering');
 await run("document.querySelector('[data-knowledge-id]').click()");
 await until(()=>run("document.querySelector('#next-knowledge-content').value.includes('Second paragraph')"),'full memory');
 assert.ok(await run("document.querySelector('[data-knowledge-id]').children.length===1&&parseFloat(getComputedStyle(document.querySelector('[data-knowledge-id] strong')).fontSize)<=12"));result.checks.push('Memory title-only compact row; full content retained');
 await shot('02-memory-open-desktop');

 await run("document.querySelector('.next-knowledge-folder-actions').open=true");
 await run("document.querySelector('#next-knowledge-folder-parent').value='';document.querySelector('#next-knowledge-folder-reparent').click()");
 await until(async()=>((await request('/api/knowledge/folders')).folders.find(folder=>folder.id===child).parentId===null),'move folder to root');
 await until(()=>run("!document.querySelector('#next-knowledge-folder-reparent').disabled"),'move released');
 await run("document.querySelector('#next-knowledge-folder-parent').value="+JSON.stringify(parent)+";document.querySelector('#next-knowledge-folder-reparent').click()");
 await until(async()=>((await request('/api/knowledge/folders')).folders.find(folder=>folder.id===child).parentId===parent),'move folder back');
 result.checks.push('Existing folder moves in UI preserve nesting and descendants');
 await run("document.querySelector('.next-knowledge-folder-actions').scrollIntoView({block:'center'});true");
 await shot('07-folder-management');
 await run("document.querySelector('#next-knowledge-root').scrollTop=0;true");

 await run("location.hash='skills'");
 await until(()=>run("!!document.querySelector('[data-skill-id^=\"saved:\"]')"),'skills catalog');
 assert.ok(await run("document.querySelector('#skills-list').textContent.includes('Research (4)')"));result.checks.push('Skills hierarchy uses descendant counts');
 await run("document.querySelector('[data-skill-id^=\"saved:\"]').click()");
 await until(()=>run("document.querySelector('#skills-content').textContent.includes('Second paragraph')"),'full skill');
 assert.ok(await run("getComputedStyle(document.querySelector('.next-skills-folder>summary'),'::before').maskImage!=='none'"));result.checks.push('Decorative recognizable folder icons present');
 assert.ok(await run("document.querySelector('[data-skill-id^=\"saved:\"]').children.length===1&&parseFloat(getComputedStyle(document.querySelector('[data-skill-id^=\"saved:\"] strong')).fontSize)<=12"));result.checks.push('Skill title-only compact row; full content retained');
 await shot('03-skills-tree-desktop');

 // Reproduce native details toggle timing, not only the DOM fixture.
 await run("(()=>{const groups=[...document.querySelectorAll('#skills-list .next-skills-folder')];groups[1].open=false;groups[0].open=false;return true})()");
 await sleep(150);
 await run("document.querySelector('#skills-query').value='Application procedure';document.querySelector('#skills-query').dispatchEvent(new Event('input',{bubbles:true}));true");
 await until(()=>run("document.querySelector('#skills-status').textContent.startsWith('4 skills')&&[...document.querySelectorAll('#skills-list .next-skills-folder')].slice(0,2).every(folder=>folder.open)"),'search reveals collapsed ancestry');
 await shot('08-search-reveals-folders');
 await run("document.querySelector('#skills-query').value='';document.querySelector('#skills-query').dispatchEvent(new Event('input',{bubbles:true}));true");
 await until(()=>run("document.querySelector('#skills-status').textContent.startsWith('7 skills')&&[...document.querySelectorAll('#skills-list .next-skills-folder')].slice(0,2).every(folder=>!folder.open)"),'clearing search restores collapse');
 result.checks.push('Search reveals nested collapsed matches without overwriting browsing collapse state');
 await shot('09-search-cleared-restores-collapse');
 await run("(()=>{for(const folder of [...document.querySelectorAll('#skills-list .next-skills-folder')].slice(0,2))folder.open=true;return true})()");
 await sleep(150);

 await run("document.querySelector('#skills-organize').click()");
 await until(()=>run("document.querySelector('#skills-editor-folder-parent')!==null"),'organizer');
 assert.ok(await run("getComputedStyle(document.querySelector('.next-skills-organizing .next-knowledge-folders-panel')).display!=='none'"));result.checks.push('Skills management accessible without leaving Skills');
 await shot('04-skills-organize-desktop');
 await run("document.querySelector('#skills-back').click()");
 win.setContentSize(640,800);await sleep(250);await shot('05-skills-compact');
 assert.ok(await run("document.querySelector('#next-stage').scrollWidth<=document.querySelector('#next-stage').clientWidth+1"));result.checks.push('Skills no horizontal overflow at640');
 await run("location.hash='knowledge'");await until(()=>run("document.querySelector('[data-space=\"knowledge\"]').getAttribute('aria-selected')==='true'"),'knowledge route');
 await run("document.querySelector('.next-knowledge-folders-panel').scrollIntoView({block:'start'});true");
 await shot('06-memory-compact');
 assert.ok(await run("document.querySelector('#next-stage').scrollWidth<=document.querySelector('#next-stage').clientWidth+1"));result.checks.push('Memory no horizontal overflow at640');
 result.passed=true;
}catch(error){result.error=error.stack;if(win){result.visibleText=await win.webContents.executeJavaScript('document.body.innerText').catch(()=>null);await writeFile(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG()).catch(()=>{});}}
finally{if(win&&!win.isDestroyed())win.destroy();if(server)await server.close();await writeFile(path.join(out,'render-result.json'),JSON.stringify(result,null,2));app.exit(result.passed?0:1);}
}
void main().catch(error=>{console.error(error.stack);app.exit(1);});
