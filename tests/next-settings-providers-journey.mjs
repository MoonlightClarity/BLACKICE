import assert from 'node:assert/strict';

/** Called by the shared hidden-Chrome harness; never starts an app or browser. */
export async function exerciseProviderSettings({evaluate,send,until,fixture,counts}){
  const {providers}=await fixture.settings();
  const syntheticKey='fixture-provider-private-key',syntheticHeader='fixture-provider-private-header';
  await providers.save({id:'fixture',apiKey:syntheticKey,headers:{'X-Fixture-Key':syntheticHeader}});
  const click=selector=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing provider journey control');node.click();return true})()`);
  const input=(selector,value)=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing provider journey field');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));return node.value})()`);
  const check=(selector,checked)=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing provider journey choice');node.checked=${JSON.stringify(checked)};node.dispatchEvent(new Event('change',{bubbles:true}));return node.checked})()`);
  const value=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`);
  const content=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`);
  const writes=()=>fixture.state.settingsPanelMutations.filter(item=>item.path==='/api/providers'&&item.method==='POST');
  const catalogCalls=()=>fixture.state.settingsPanelMutations.filter(item=>/^\/api\/providers\/[^/]+\/models$/.test(item.path));
  const idle=()=>until(()=>evaluate('document.querySelector("#next-provider-root")?.getAttribute("aria-busy")==="false" && !document.querySelector("#next-provider-new").disabled'),'Provider action settled');
  const openFixture=async()=>{await click('[data-provider-id="fixture"]');await until(()=>value('#next-provider-name').then(name=>Boolean(name)),'Fixture provider editor');};
  await click('#next-settings-section-models');
  await until(()=>evaluate('Boolean(document.querySelector("#next-provider-list [data-provider-id=fixture]"))'),'Provider connection metadata');
  assert.match(await content('[data-provider-id="fixture"]'),/Fixture model connection/);
  assert.match(await content('[data-provider-id="fixture"]'),/Enabled · configured/);
  await openFixture();
  assert.equal(await value('#next-provider-name'),'Fixture model connection');
  assert.equal(await value('#next-provider-key'),'','Saved secret values are never sent to the editor.');
  assert.equal(await value('#next-provider-headers'),'');
  assert.match(await content('#next-provider-key-note'),/saved/);
  assert.match(await content('#next-provider-header-note'),/X-Fixture-Key/);
  assert.equal(await evaluate('document.querySelector("#next-provider-id").disabled'),true);

  // Drafts survive a Settings subsection and the complete workspace lifecycle.
  const beforeDraft=writes().length;
  await input('#next-provider-name','Fixture provider draft');
  await input('#next-provider-manual-model','Not yet selected');
  await evaluate('document.querySelector("#next-provider-name").focus();true');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await evaluate('document.querySelector("#next-provider-form").requestSubmit();true');
  await click('#next-settings-section-general');
  fixture.send({type:'runtime.status',data:fixture.state.status});
  await click('#next-settings-section-models');
  await until(()=>value('#next-provider-name').then(name=>name==='Fixture provider draft'),'Provider draft after subsection navigation');
  await click('.next-tab[data-space="planning"]');
  fixture.send({type:'runtime.status',data:fixture.state.status});
  await click('.next-tab[data-space="settings"]');
  await until(()=>evaluate('document.querySelector("#next-settings-section-models").getAttribute("aria-selected")==="true" && !document.querySelector("#next-provider-refresh").disabled'),'Provider draft after workspace navigation');
  assert.equal(await value('#next-provider-name'),'Fixture provider draft');
  assert.equal(await value('#next-provider-manual-model'),'Not yet selected');
  await click('#next-provider-refresh');
  await until(()=>evaluate('!document.querySelector("#next-provider-refresh").disabled'),'Provider explicit metadata refresh');
  assert.equal(await value('#next-provider-name'),'Fixture provider draft');
  assert.equal(writes().length,beforeDraft,'Navigation, events, Enter and refresh never save provider drafts.');
  counts.providerDraftNavigation=true;

  await input('#next-provider-name','Fixture provider renamed');
  await click('#next-provider-save');
  await until(()=>providers.get('fixture').name==='Fixture provider renamed','Provider saved through actual ProviderStore');await idle();
  const firstSave=writes().at(-1).body;
  assert.equal(Object.hasOwn(firstSave,'apiKey'),false,'Blank key must preserve the saved value.');
  assert.equal(Object.hasOwn(firstSave,'headers'),false,'Blank headers must preserve the saved set.');
  assert.equal(providers.key('fixture'),syntheticKey);assert.deepEqual(providers.extraHeaders('fixture'),{'X-Fixture-Key':syntheticHeader});
  assert.deepEqual(providers.get('fixture').models,[{id:'model',displayName:'Fixture model',contextWindowTokens:100000,contextWindowSource:'user-configured',supportsTools:true}]);
  assert.equal(await evaluate(`Object.values(localStorage).concat(Object.values(sessionStorage)).some(value=>String(value).includes(${JSON.stringify(syntheticKey)})||String(value).includes(${JSON.stringify(syntheticHeader)}))`),false);
  await check('#next-provider-clear-key',true);await check('#next-provider-clear-headers',true);
  await click('#next-provider-save');await until(()=>providers.key('fixture')===''&&Object.keys(providers.extraHeaders('fixture')).length===0,'Explicit provider credential removal');await idle();
  assert.equal(writes().at(-1).body.apiKey,'');assert.deepEqual(writes().at(-1).body.headers,{});
  assert.equal(await evaluate('document.querySelector("#next-provider-clear-key").checked'),false);
  counts.providerSecretsAndMetadata=true;

  // New connection settings, selected models and deletion all use explicit buttons.
  await click('#next-provider-new');
  await evaluate('(()=>{const node=document.querySelector("#next-provider-preset");node.value="compatible";node.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await input('#next-provider-id','extra');await input('#next-provider-name','Extra fixture API');
  await input('#next-provider-base-url','http://extra.fixture.invalid/v1');
  await input('#next-provider-max-tokens','16384');await input('#next-provider-max-steps','');
  await input('#next-provider-manual-model','extra-model');await click('#next-provider-add-model');
  await click('#next-provider-save');await until(()=>Boolean(providers.get('extra')),'Create actual provider connection');await idle();
  assert.equal(providers.get('extra').maxTokens,16384);assert.equal(providers.get('extra').maxSteps,null);
  assert.equal(providers.get('extra').models[0].id,'extra-model');
  await input('#next-provider-name','Extra fixture renamed');await click('#next-provider-save');await until(()=>providers.get('extra').name==='Extra fixture renamed','Edit newly saved provider');await idle();
  await click('#next-provider-delete');await until(()=>!providers.get('extra'),'Remove actual provider connection');await idle();
  assert.equal(await evaluate('Boolean(document.querySelector("[data-provider-id=extra]"))'),false);
  counts.providerCRUD=true;

  await openFixture();
  const beforeCatalog=catalogCalls().length;
  await input('#next-provider-catalog-search','');
  assert.equal(catalogCalls().length,beforeCatalog,'Typing a search never sends a catalog request.');
  await click('#next-provider-catalog-load');
  await until(()=>evaluate('Boolean(document.querySelector("[data-provider-model-id=catalog-model-0]")) && !document.querySelector("#next-provider-catalog-load").disabled'),'First explicit provider catalog page');
  assert.equal(await evaluate('document.querySelectorAll("#next-provider-models input, #next-provider-catalog input").length'),80,'Only one catalog page and the selected models are mounted.');
  assert.match(await content('#next-provider-catalog-page'),/1–80 of 121/);
  await click('#next-provider-catalog-next');
  await until(()=>evaluate('Boolean(document.querySelector("[data-provider-model-id=catalog-model-99]")) && !document.querySelector("#next-provider-catalog-load").disabled'),'Provider catalog second page');
  await check('[data-provider-model-id="catalog-model-99"]',true);
  await click('#next-provider-catalog-prev');
  await until(()=>evaluate('Boolean(document.querySelector("#next-provider-catalog [data-provider-model-id=catalog-model-0]")) && !document.querySelector("#next-provider-catalog-load").disabled'),'Provider catalog previous page');
  assert.equal(await evaluate('document.querySelector("#next-provider-models [data-provider-model-id=catalog-model-99]").checked'),true);
  await input('#next-provider-catalog-search','catalog-model-119');await click('#next-provider-catalog-load');
  await until(()=>evaluate('Boolean(document.querySelector("#next-provider-catalog [data-provider-model-id=catalog-model-119]")) && !document.querySelector("#next-provider-catalog-load").disabled'),'Explicit provider catalog search');
  await check('[data-provider-model-id="catalog-model-119"]',true);
  await click('#next-provider-save');await until(()=>providers.get('fixture').models.length===3,'Selected provider models saved across pages');await idle();
  const models=providers.get('fixture').models;
  assert.deepEqual(models.map(model=>model.id),['model','catalog-model-99','catalog-model-119']);
  assert.equal(models[0].contextWindowTokens,100000);assert.equal(models[0].contextWindowSource,'user-configured');assert.equal(models[0].supportsTools,true);
  for(const model of models.slice(1)){assert.equal(model.contextWindowTokens,128000);assert.equal(model.contextWindowSource,'provider-reported');assert.equal(model.supportsTools,true);}
  assert.deepEqual(catalogCalls().slice(beforeCatalog).map(call=>call.body),[{query:'',offset:0,limit:80},{query:'',offset:80,limit:80},{query:'',offset:0,limit:80},{query:'catalog-model-119',offset:0,limit:80}]);
  await click('#next-provider-test');await idle();
  await until(()=>content('#next-provider-receipt').then(text=>text.includes('API key verified')),'Explicit provider test receipt');
  assert.match(await content('#next-provider-receipt'),/Model access was not tested/);
  counts.providerCatalogPaging=true;counts.providerTestAccurate=true;

  await evaluate('document.querySelector("#next-provider-codex").open=true;true');
  await click('#next-provider-codex-read');
  await until(()=>evaluate('document.querySelector("#next-provider-codex-list")?.textContent.includes("codex-test") && !document.querySelector("#next-provider-codex-read").disabled'),'Explicit native model status');
  await input('#next-provider-codex-id','fixture-native-custom');await click('#next-provider-codex-add');
  await until(()=>providers.listCodexModels().includes('fixture-native-custom'),'Save exact native Codex model ID');await idle();
  assert.equal(await value('#next-provider-codex-id'),'');
  await input('#next-provider-codex-id','fixture-native-custom');await click('#next-provider-codex-check');await idle();
  await until(()=>content('#next-provider-codex-status').then(text=>text.includes('Request completed')),'Native model observed request result');
  assert.match(await content('#next-provider-codex-status'),/Current account and connection/);
  assert.match(await content('#next-provider-codex-status'),/Future requests can have a different result/);
  await click('[data-codex-remove="fixture-native-custom"]');await until(()=>!providers.listCodexModels().includes('fixture-native-custom'),'Remove saved native model ID');await idle();
  counts.providerCodexCustomIDs=true;

  const previous=await evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
  try{
    await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
    await evaluate('document.querySelector("#next-provider-editor details").open=true;true');
    for(const selector of ['#next-provider-preset','#next-provider-protocol','#next-provider-name','#next-provider-base-url','#next-provider-key','#next-provider-clear-key','#next-provider-headers','#next-provider-clear-headers','#next-provider-max-tokens','#next-provider-max-steps','#next-provider-manual-model','#next-provider-catalog-search','#next-provider-catalog-load','#next-provider-save','#next-provider-test','#next-provider-delete','#next-provider-codex-id','#next-provider-codex-add','#next-provider-codex-check']){
      const reachable=await evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const rect=node.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);return {visible:rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,uncovered:hit===node||node.contains(hit),width:document.querySelector('#next-provider-root').scrollWidth,viewport:innerWidth}})()`);
      assert.equal(reachable.visible,true,selector+' stays reachable at 780×560 and 150% DPR.');assert.equal(reachable.uncovered,true,selector+' is not covered by another panel.');assert.ok(reachable.width<=reachable.viewport,'Provider panel must not require horizontal page scrolling.');
    }
  }finally{await send('Emulation.setDeviceMetricsOverride',{...previous,mobile:false});}
  counts.providerCompactReachable=true;
}
