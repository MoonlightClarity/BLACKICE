import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {coordinationNavigation} from '../public/coordination-navigation.mjs';

test('coordination navigation names the same destinations with exactly one current area',()=>{
  for(const current of ['planning','swarms','schedules']){
    const html=coordinationNavigation(current);
    assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/g)].map(match=>match[1]),['planning','projects','operations']);
    assert.equal([...html.matchAll(/aria-current="page" disabled/g)].length,1);
    assert.match(html,/aria-label="Planning, swarms and schedules"/);
    assert.doesNotMatch(html,/data-op="run"|data-project="start"|type="submit"/);
  }
});

test('swarms and schedules stay discoverable in the header and compact menu',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/coordination-navigation.css',import.meta.url),'utf8');
  assert.match(app,/class="workspace-projects" data-action="projects" aria-label="Swarms"/);
  assert.match(app,/class="workspace-schedules" data-action="operations" aria-label="Schedules and cronjobs"/);
  const menu=/<details class="workspace-menu">([\s\S]*?)<\/details>/.exec(app)[1];
  assert.match(menu,/<button data-action="projects">Swarms<\/button>/);
  assert.match(menu,/<button data-action="operations">Schedules &amp; cronjobs<\/button>/);
  assert.match(css,/@media\(max-width:1100px\)/);
  assert.match(css,/\.coordination-navigation button:focus-visible/);
});
