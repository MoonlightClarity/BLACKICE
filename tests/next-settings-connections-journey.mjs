import assert from 'node:assert/strict';

/** Browser acceptance against the disposable real ConnectionManager. The fixture
 * supplies every MCP response internally and rejects any attempted tool call. */
export async function exerciseConnectionSettings({evaluate,send,until,fixture,counts}) {
  const {connections}=await fixture.settings(),id='settings-http-fixture',endpoint='https://settings-fixture.invalid/mcp';
  const route='/api/connections/'+id;
  const mutations=()=>fixture.state.settingsPanelMutations.filter(item=>item.path.startsWith('/api/connections'));
  const requests=()=>fixture.state.settingsPanelRequests.filter(item=>item.includes('/api/connections'));
  const saved=()=>connections.list().find(entry=>entry.id===id);
  const click=async name=>evaluate('document.querySelector('+JSON.stringify('#next-connections-'+name)+').click();true');
  const fill=async values=>evaluate('(()=>{for(const [name,value] of Object.entries('+JSON.stringify(values)+')){const node=document.querySelector("#next-connections-"+name);if(name==="enabled")node.checked=value;else node.value=value;node.dispatchEvent(new Event(["transport","enabled"].includes(name)?"change":"input",{bubbles:true}));}return true})()');
  const field=async name=>evaluate('document.querySelector('+JSON.stringify('#next-connections-'+name)+')?.value');
  const feedback=()=>evaluate('document.querySelector("#next-connections-feedback")?.textContent||""');
  const settled=label=>until(()=>evaluate('document.querySelector("#next-connections-save")?.disabled===true && document.querySelector("#next-connections-refresh")?.disabled===false'),label);
  const save=async label=>{
    const before=mutations().length;await click('save');await click('save');
    await until(async()=>mutations().length===before+1&&(await feedback()).includes('settings saved'),label);
    await settled(label+' settled');return mutations().at(-1).body;
  };
  assert.equal(saved(),undefined,'The journey must begin with its own empty synthetic record.');
  const protocolStart=fixture.state.settingsProtocolCalls.length,mutationsStart=mutations().length;
  await evaluate('document.querySelector(".next-tab[data-space=settings]").click();true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-settings-section-connections"))'),'Tool settings section');
  await evaluate('document.querySelector("#next-settings-section-connections").click();true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-connections-name")) && !document.querySelector("#next-settings-connections").hidden && !document.querySelector("#next-connections-refresh").disabled'),'Native tool connections panel');
  await click('new');
  await fill({id,name:'Synthetic HTTP tools',transport:'http',url:endpoint,timeout:'12.501',enabled:true,
    env:'{"TOKEN":"synthetic-environment"}',headers:'{"Authorization":"Bearer synthetic-header"}'});

  await evaluate('document.querySelector("#next-settings-section-general").click();true');
  await until(()=>evaluate('document.querySelector("#next-settings-general")?.hidden===false'),'General settings round trip');
  await evaluate('document.querySelector("#next-settings-section-connections").click();true');
  await until(()=>evaluate('document.querySelector("#next-settings-connections")?.hidden===false'),'Tool subtab draft return');
  assert.equal(await field('name'),'Synthetic HTTP tools');assert.equal(await field('url'),endpoint);
  await evaluate('document.querySelector(".next-tab[data-space=chat]").click();true');
  await until(()=>evaluate('document.querySelector(".next-tab[data-space=chat]")?.getAttribute("aria-selected")==="true"'),'Leave unsaved tool draft');
  const hiddenReads=requests().length;
  fixture.send({type:'connections.updated',data:connections.status()});
  await new Promise(resolve=>setTimeout(resolve,230));
  assert.equal(requests().length,hiddenReads,'The hidden Tools panel must unsubscribe instead of fetching status.');
  await evaluate('document.querySelector(".next-tab[data-space=settings]").click();document.querySelector("#next-settings-section-connections").click();true');
  await until(()=>evaluate('document.querySelector("#next-settings-connections")?.hidden===false && !document.querySelector("#next-connections-refresh")?.disabled'),'Tool workspace draft return');
  assert.equal(await field('name'),'Synthetic HTTP tools');assert.equal(await field('headers'),'{"Authorization":"Bearer synthetic-header"}');
  assert.equal(mutations().length,mutationsStart,'Editing, subtab switches and workspace switches must not save or connect.');
  assert.equal(fixture.state.settingsProtocolCalls.length,protocolStart,'Typing a draft cannot start an MCP connection.');
  assert.equal(await evaluate('(()=>{const node=document.querySelector("#next-connections-url"),event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented})()'),true,'Enter in a field must not implicitly save.');

  const viewport=await evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  try{
    await evaluate('document.querySelector(".next-connections-credentials").open=true;true');
    const names=['id','name','transport','timeout','url','env','headers','save','reload','connect','disconnect','remove','query','catalog-read'];
    for(const name of names){
      const geometry=await evaluate('(()=>{const node=document.querySelector('+JSON.stringify('#next-connections-'+name)+');node.scrollIntoView({block:"center",inline:"nearest"});const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,reachable:hit===node||node.contains(hit)}})()');
      assert.ok(geometry.width>20&&geometry.height>16,name+' must have a usable control size at 150% scale.');
      assert.ok(geometry.left>=-1&&geometry.right<=geometry.viewportWidth+1,name+' must fit the compact viewport horizontally: '+JSON.stringify(geometry));
      assert.ok(geometry.top>=-1&&geometry.bottom<=geometry.viewportHeight+1&&geometry.reachable,name+' must remain reachable by scrolling: '+JSON.stringify(geometry));
    }
    assert.equal(await evaluate('document.querySelector("#next-connections-root").scrollWidth<=document.querySelector("#next-connections-root").clientWidth+1'),true,'The tool form must not overflow its compact panel.');
  }finally{await send('Emulation.setDeviceMetricsOverride',{...viewport,mobile:false});}
  counts.settingsConnectionsCompact={width:780,height:560,scale:1.5,controls:14};

  const created=await save('Explicit HTTP connection settings save');
  assert.equal(created.id,id);assert.equal(created.transport,'http');assert.equal(created.url,endpoint);assert.equal(created.timeoutMs,12501);
  assert.deepEqual(created.env,{TOKEN:'synthetic-environment'});assert.deepEqual(created.headers,{Authorization:'Bearer synthetic-header'});
  assert.equal(saved().connected,false);assert.equal(fixture.state.settingsProtocolCalls.length,protocolStart,'Save must not connect.');
  assert.equal(await field('env'),'');assert.equal(await field('headers'),'','Saved credentials must not be reflected back into the editor.');
  assert.deepEqual(connections.secrets.get(id),{env:{TOKEN:'synthetic-environment'},headers:{Authorization:'Bearer synthetic-header'}});

  const connectStart=mutations().length;await click('connect');await click('connect');
  await until(async()=>saved()?.connected===true&&(await evaluate('document.querySelector("#next-connections-disconnect")?.disabled===false')),'Explicit synthetic MCP connection');
  assert.equal(mutations().length,connectStart+1);assert.equal(mutations().at(-1).path,route+'/connect');
  assert.match(await evaluate('document.querySelector("#next-connections-status").textContent'),/^Connected/);
  assert.ok(fixture.state.settingsProtocolCalls.slice(protocolStart).includes('initialize'));
  assert.ok(fixture.state.settingsProtocolCalls.slice(protocolStart).includes('tools/list'));
  const disconnectStart=mutations().length;await click('disconnect');await click('disconnect');
  await until(async()=>saved()?.connected===false&&(await evaluate('document.querySelector("#next-connections-connect")?.disabled===false')),'Explicit synthetic MCP disconnection');
  assert.equal(mutations().length,disconnectStart+1);assert.equal(mutations().at(-1).path,route+'/disconnect');
  assert.match(await evaluate('document.querySelector("#next-connections-status").textContent'),/^Disconnected/);

  const catalogStart=requests().filter(item=>item.endsWith('/tools')).length,protocolBeforeCatalog=fixture.state.settingsProtocolCalls.length;
  await fill({});await evaluate('document.querySelector("#next-connections-query").value="";document.querySelector("#next-connections-query").dispatchEvent(new Event("input",{bubbles:true}));true');
  assert.equal(requests().filter(item=>item.endsWith('/tools')).length,catalogStart);
  assert.equal(fixture.state.settingsProtocolCalls.length,protocolBeforeCatalog);
  await click('catalog-read');await until(()=>evaluate('document.querySelectorAll("#next-connections-catalog article").length===20'),'Bounded tool catalog');
  assert.equal(saved().connected,true,'Explicit catalog reading connects the saved server.');
  assert.match(await evaluate('document.querySelector("#next-connections-catalog-note").textContent'),/20 of 120.*Narrow your search/);
  await click('catalog-more');assert.equal(await evaluate('document.querySelectorAll("#next-connections-catalog article").length'),40);
  await until(()=>evaluate('document.querySelector("#next-connections-catalog-read")?.disabled===false'),'Catalog action complete');
  await evaluate('document.querySelector("#next-connections-query").value="fixture_tool_119";true');await click('catalog-read');
  await until(()=>evaluate('document.querySelectorAll("#next-connections-catalog article").length===1 && document.querySelector("#next-connections-catalog article code")?.textContent==="fixture_tool_119"'),'Narrow search reaches an unmounted tool');
  assert.match(await evaluate('document.querySelector("#next-connections-catalog-note").textContent'),/^1 of 1 matching tools$/);
  assert.equal(requests().filter(item=>item.endsWith('/tools')).length,catalogStart+2);
  assert.equal(fixture.state.settingsProtocolCalls.includes('tools/call'),false,'Catalog browsing must never invoke a tool.');

  await until(()=>evaluate('document.querySelector("#next-connections-refresh")?.disabled===false && document.querySelector("#next-connections-catalog-read")?.disabled===false'),'Catalog state settled');
  await fill({name:'Renamed synthetic tools'});const renamed=await save('Rename while preserving credentials');
  assert.equal(Object.hasOwn(renamed,'env'),false);assert.equal(Object.hasOwn(renamed,'headers'),false);
  assert.deepEqual(connections.secrets.get(id),{env:{TOKEN:'synthetic-environment'},headers:{Authorization:'Bearer synthetic-header'}});
  assert.equal(saved().connected,false,'Configuration Save disconnects without reconnecting.');

  const destinationStart=mutations().length;await fill({url:'https://settings-other.invalid/mcp'});await click('save');
  await until(async()=>(await feedback()).includes('destination changed'),'Changed destination requires environment replacement');
  assert.equal(mutations().length,destinationStart);assert.match(await feedback(),/environment variables/);assert.equal(saved().url,endpoint);
  await fill({env:'{"TOKEN":"replacement-environment"}'});await click('save');
  await until(async()=>(await feedback()).includes('HTTP headers'),'Changed destination requires header replacement');
  assert.equal(mutations().length,destinationStart);assert.equal(saved().url,endpoint);
  await fill({headers:'{"Authorization":"Bearer replacement-header"}'});await save('Explicit replacement credentials for changed destination');
  assert.equal(saved().url,'https://settings-other.invalid/mcp');
  assert.deepEqual(connections.secrets.get(id),{env:{TOKEN:'replacement-environment'},headers:{Authorization:'Bearer replacement-header'}});
  await fill({headers:'{}'});const cleared=await save('Explicit empty headers clear only that credential group');
  assert.deepEqual(cleared.headers,{});assert.equal(Object.hasOwn(cleared,'env'),false);
  assert.deepEqual(connections.secrets.get(id),{env:{TOKEN:'replacement-environment'},headers:{}});

  await fill({name:'Keep this conflicting tool draft'});
  await connections.save({...saved(),name:'Changed outside the panel'});
  fixture.send({type:'connections.updated',data:connections.status()});
  const beforeConflict=mutations().length;await click('save');
  await until(async()=>(await feedback()).includes('changed since editing began'),'Stale connection save blocked');
  assert.equal(mutations().length,beforeConflict);assert.equal(saved().name,'Changed outside the panel');
  assert.equal(await field('name'),'Keep this conflicting tool draft','Conflict must retain the local draft.');
  await until(()=>evaluate('document.querySelector("#next-connections-reload")?.disabled===false'),'Explicit reload available after conflict');
  await click('reload');assert.equal(await field('name'),'Changed outside the panel');
  assert.equal(mutations().length,beforeConflict,'Reload is read-only and must not replay the rejected Save.');
  assert.equal(await field('env'),'');assert.equal(await field('headers'),'');

  const removalStart=mutations().length;await click('remove');await click('remove');
  await until(async()=>!saved()&&(await feedback()).includes('Connection removed'),'Explicit server removal');
  assert.equal(mutations().length,removalStart+1);assert.equal(mutations().at(-1).method,'DELETE');assert.equal(mutations().at(-1).path,route);
  assert.equal(connections.secrets.has(id),false);assert.equal(await field('name'),'');
  assert.equal(fixture.state.settingsProtocolCalls.includes('tools/call'),false);
  counts.settingsConnections={httpCrud:true,saveDoesNotConnect:true,draftKept:true,noImplicitWrites:true,connectDisconnect:true,
    catalogInitial:20,catalogExpanded:40,catalogSearch:true,credentialsPreserved:true,explicitClear:true,destinationRebind:true,staleDraftKept:true,remove:true};
}
