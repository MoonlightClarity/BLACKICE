import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Uses only disposable storage and the shared hidden-Chrome test session. */
export async function exerciseConnectionImportSettings({evaluate,send,until,fixture,counts}){
  const {connections,directory}=await fixture.settings();
  const click=selector=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing configuration import control');node.click();return true})()`);
  const input=value=>evaluate(`(()=>{const node=document.querySelector('#next-settings-import-source');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const field=()=>evaluate('document.querySelector("#next-settings-import-source").value');
  const status=()=>evaluate('document.querySelector("#next-settings-import-status").textContent');
  const error=()=>evaluate('document.querySelector("#next-settings-import-error").textContent');
  const mutations=()=>fixture.state.settingsPanelMutations.filter(item=>item.path==='/api/connections/import');
  const applies=()=>mutations().filter(item=>item.body.apply===true);
  const idle=()=>until(()=>evaluate('document.querySelector("#next-settings-import-root").getAttribute("aria-busy")==="false"'),'Configuration import settled');
  const read=async()=>{await click('#next-settings-import-read');await until(()=>evaluate('document.querySelector("#next-settings-import-apply").disabled===false'),'Configuration preview ready');};
  const preserved=await connections.save({id:'import-preserved',name:'Preserved existing server',transport:'stdio',command:'synthetic-original-command',args:[],enabled:true});
  const secret='synthetic-import-private-token',header='synthetic-import-private-header',argument='synthetic-private-argument';
  const config={connections:[{id:'import-preserved',name:'Imported local <script> marker',transport:'stdio',command:'synthetic-import-command',args:[argument],env:{TOKEN:secret},autoStart:true},
    {id:'import-http',name:'Imported HTTP',transport:'http',url:'https://configuration-fixture.invalid/mcp',headers:{Authorization:'Bearer '+header},enabled:false}]};
  const source=JSON.stringify(config,null,2),file=join(directory,'configuration-import-fixture.json');await writeFile(file,source);
  const protocolStart=fixture.state.settingsProtocolCalls.length,applyStart=applies().length;
  await click('.next-tab[data-space=settings]');await until(()=>evaluate('Boolean(document.querySelector("#next-settings-section-connections"))'),'Tools settings navigation');
  await click('#next-settings-section-connections');await until(()=>evaluate('Boolean(document.querySelector("#next-settings-import-root")) && !document.querySelector("#next-settings-connections").hidden'),'Native configuration import mounted');
  await evaluate('document.querySelector("#next-connections-import").open=true;true');
  await evaluate('(()=>{const node=document.querySelector("#next-connections-name");node.value="Independent unsaved tool draft";node.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  // Set the real file input without opening an OS picker in hidden automation.
  const doc=await send('DOM.getDocument'),fileNode=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#next-settings-import-file'});
  await send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[file]});
  await until(()=>evaluate('document.querySelector("#next-settings-import-apply").disabled===false'),'JSON file read and server-side preview');
  assert.equal(await field(),source);assert.equal(applies().length,applyStart,'Selecting a JSON file previews without saving.');
  assert.equal(connections.list().some(entry=>entry.id==='import-preserved-2'),false);
  const preview=await evaluate('document.querySelector("#next-settings-import-preview").textContent');
  for(const value of [secret,header,argument])assert.equal(preview.includes(value),false,'The metadata preview omits credentials and command arguments.');
  assert.equal(await evaluate('document.querySelector("#next-settings-import-preview script")===null'),true);
  assert.match(preview,/import-preserved-2/);assert.equal(fixture.state.settingsProtocolCalls.length,protocolStart);

  await click('#next-settings-section-general');await click('#next-settings-section-connections');
  await until(()=>evaluate('!document.querySelector("#next-settings-connections").hidden'),'Import draft after Settings subsection navigation');
  await click('.next-tab[data-space=planning]');fixture.send({type:'connections.updated',data:connections.status()});
  await click('.next-tab[data-space=settings]');await until(()=>evaluate('!document.querySelector("#next-settings-connections").hidden'),'Import draft after workspace navigation');
  assert.equal(await field(),source);assert.equal(applies().length,applyStart);assert.equal(fixture.state.settingsProtocolCalls.length,protocolStart);
  assert.equal(await evaluate(`Object.values(localStorage).concat(Object.values(sessionStorage)).some(value=>String(value).includes(${JSON.stringify(secret)})||String(value).includes(${JSON.stringify(header)}))`),false);

  let release;const gate=new Promise(resolve=>{release=resolve;});let held=false;
  fixture.state.settingsImportGate=async body=>{if(body.apply){held=true;await gate;}};
  try{
    await click('#next-settings-import-apply');await click('#next-settings-import-apply');await until(()=>held,'Hold actual configuration import receipt');
    assert.equal(await evaluate('document.querySelector("#next-connections-save").disabled'),true,'Import and individual connection writes share a lock.');
    await click('.next-tab[data-space=planning]');const hiddenRequests=fixture.state.settingsPanelRequests.length;release();
    await until(()=>field().then(value=>value===''),'Successful explicit import clears the hidden sensitive draft');
    assert.equal(fixture.state.settingsPanelRequests.length,hiddenRequests,'A hidden import completion must not fetch or connect.');
  }finally{release();fixture.state.settingsImportGate=null;}
  await click('.next-tab[data-space=settings]');await until(()=>evaluate('!document.querySelector("#next-settings-connections").hidden && !document.querySelector("#next-connections-refresh").disabled'),'Imported saved servers after workspace return');
  await idle();assert.equal(applies().length,applyStart+1);assert.match(await status(),/2 tool servers imported/);
  assert.equal(await evaluate('document.querySelector("#next-connections-name").value'),'Independent unsaved tool draft');
  assert.deepEqual(connections.list().find(entry=>entry.id==='import-preserved'),preserved,'Existing settings remain unchanged.');
  assert.deepEqual(connections.secrets.get('import-preserved-2'),{env:{TOKEN:secret},headers:{}});
  assert.deepEqual(connections.secrets.get('import-http'),{env:{},headers:{Authorization:'Bearer '+header}});
  assert.equal(connections.list().find(entry=>entry.id==='import-http').enabled,false);
  assert.equal(connections.list().filter(entry=>entry.id.startsWith('import-')).every(entry=>!entry.connected),true);
  assert.equal(fixture.state.settingsProtocolCalls.length,protocolStart,'Imported stdio commands must never start during import.');

  const partial={connections:[{id:'partial-one',name:'Partial first',command:'synthetic-never-run',args:[]},{id:'partial-two',name:'Partial second',command:'synthetic-never-run',args:[]}]};
  const partialSource=JSON.stringify(partial);await input(partialSource);await read();fixture.state.settingsImportFailureAt=1;
  const beforePartial=applies().length;await click('#next-settings-import-apply');await until(()=>error().then(value=>value.includes('1 of 2')),'Configuration409 reports saved prefix');await idle();
  assert.equal(connections.list().some(entry=>entry.id==='partial-one'),true);assert.equal(connections.list().some(entry=>entry.id==='partial-two'),false);assert.equal(await field(),partialSource);
  assert.equal(await evaluate('document.querySelector("#next-settings-import-apply").disabled && document.querySelector("#next-settings-import-read").disabled'),true);
  await click('#next-settings-import-apply');assert.equal(applies().length,beforePartial+1,'A partial import cannot replay the stale preview.');
  await click('#next-settings-import-reload');await idle();await input(JSON.stringify({connections:[partial.connections[1]]}));await read();
  await click('#next-settings-import-apply');await until(()=>connections.list().some(entry=>entry.id==='partial-two'),'Import only the remaining server');await idle();
  assert.equal(connections.list().some(entry=>entry.id==='partial-one-2'),false);assert.equal(fixture.state.settingsProtocolCalls.length,protocolStart);

  const viewport=await evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
  try{
    await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
    for(const selector of ['#next-settings-import-source','#next-settings-import-file-choose','#next-settings-import-read','#next-settings-import-apply','#next-settings-import-reload','#next-settings-import-clear']){
      const geometry=await evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,reachable:hit===node||node.contains(hit)}})()`);
      assert.equal(geometry.visible,true,selector+' fits the compact viewport.');assert.equal(geometry.reachable,true,selector+' remains reachable by scrolling.');
    }
  }finally{await send('Emulation.setDeviceMetricsOverride',{...viewport,mobile:false});}
  counts.settingsConfigurationImport={jsonFile:true,preview:true,explicitApply:true,noConnect:true,existingPreserved:true,secretsOmittedFromPreview:true,draftNavigation:true,partial409:true,compactReachable:true};
}
