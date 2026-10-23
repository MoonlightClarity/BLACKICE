import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=name=>readFile(new URL('../public/'+name,import.meta.url),'utf8');

test('mobile navigation gives each real workspace destination its own track',async()=>{
  const files=['blackice-type.css','workflow-map.css','blackice-experience.css','blackice-components.css'];
  const [app,...styles]=await Promise.all([read('app.js'),...files.map(read)]),css=styles[0];
  const nav=/<nav role="tablist" aria-label="Workspace mode">([\s\S]*?)<\/nav>/.exec(app)?.[1];assert.ok(nav,'primary workspace tablist exists');
  const destinations=[...nav.matchAll(/<button[^>]*data-mode="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  const mobile=css.slice(css.lastIndexOf('@media(max-width:540px)'));
  const tracks=/grid-template-columns:repeat\((\d+),minmax\(0,1fr\)\)/.exec(mobile);
  assert.ok(tracks,'small-screen navigation has explicit equal-width tracks');
  assert.equal(Number(tracks[1]),destinations.length,'adding a workspace destination must not leave a tab on an unaccounted third header row');
  assert.deepEqual(destinations.map(match=>match[1]),['view','observe','planning','configure']);
  assert.deepEqual(destinations.map(match=>/<span class="workspace-tab-label">([^<]+)<\/span>/.exec(match[2])?.[1]),['Chat','Activity','Planning','Settings']);
  assert.doesNotMatch(nav,/data-action="(?:projects|workflow)"/,'dialog and advanced-canvas actions are not workspace tabs');
  const menu=/<details class="workspace-menu">([\s\S]*?)<\/details>/.exec(app)?.[1];assert.ok(menu);
  assert.match(menu,/<button data-action="projects">Swarms<\/button>/,'Swarms stays available from the compact workspace menu');
  assert.doesNotMatch(app,/<button\b[^>]*class="workspace-(?:projects|schedules)"/,'secondary destinations do not add persistent header controls');
  for(const[index,style]of styles.entries()){
    const rules=[...style.matchAll(/#workspace-modes(?:\s+|\s*>\s*)nav(?:\[role="tablist"\])?\s*\{([^}]*)\}/g)];
    const trackCounts=rules.flatMap(rule=>[...rule[1].matchAll(/grid-template-columns\s*:\s*repeat\(\s*(\d+)\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/g)].map(match=>Number(match[1])));
    assert.ok(trackCounts.length,`${files[index]} defines responsive workspace tracks`);
    assert.ok(trackCounts.every(count=>count===destinations.length),`${files[index]} must agree with the real tabs at every navigation breakpoint`);
  }
  assert.match(styles[2],/#workspace-modes>nav\[role="tablist"\]\s*\{\s*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\s*!important/,'the final high-specificity navigation override keeps all four tabs on one row');
  assert.match(mobile,/grid-template-rows:32px 34px/,'tab rows retain the established mobile shell height');
});

test('collapsed model and project controls retain reachable menu actions',async()=>{
  const app=await read('app.js'),menu=/<details class="workspace-menu">([\s\S]*?)<\/details>/.exec(app)?.[1];assert.ok(menu);
  for(const action of ['projects','models-connections','email','planning','operations','workflow'])assert.match(menu,new RegExp(`data-action="${action}"`),`${action} stays reachable after its optional header shortcut is hidden`);
  assert.match(menu,/<button data-action="planning">Planning workspace<\/button>/,'the shared saved plan workspace remains directly reachable from the menu');
  assert.doesNotMatch(menu,/data-action="task-notes"|Save as method|Method catalog/,'the former notes and Methods workflows do not duplicate Planning in the menu');
  assert.doesNotMatch(menu,/chatgpt-bridge/,'the retired Bridge is not offered by the compact menu');
  const advanced=menu.indexOf('<span class="workspace-menu-label">Advanced</span>');assert.ok(advanced>=0,'advanced actions have a named menu section');
  assert.match(menu.slice(advanced),/<button data-action="workflow">Workflow canvas<\/button>/,'the existing graph stays explicitly reachable as the advanced Workflow canvas');
  assert.match(menu,/<summary aria-label="Workspace menu">/,'the remaining compact menu keeps its accessible name');
});

test('fixed shell cannot silently pan on focus while its long menu keeps a bounded scroll area',async()=>{
  const css=await read('blackice-type.css'),shell=css.slice(css.indexOf('/* The page is a fixed shell;'));
  assert.match(shell,/html,body\{[^}]*overflow:clip!important/,'overflow:hidden allows focus to move the body scroll position');
  assert.match(shell,/\.workspace-menu>div\{[^}]*max-height:[^;]+;[^}]*overflow-y:auto/,'the menu must remain scrollable when the page itself cannot pan');
  assert.match(shell,/\.workspace-menu>summary\{[^}]*min-width:34px/,'the final compact menu retains a usable hit target');
});
