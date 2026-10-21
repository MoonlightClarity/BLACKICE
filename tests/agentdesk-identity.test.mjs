import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const get=relative=>readFile(new URL('../'+relative,import.meta.url),'utf8');

test('BLACKICE visual rebrand preserves all existing Relay storage and API identities',async()=>{
 const [index,desktop,app,mission,icon]=await Promise.all(['public/index.html','desktop/main.mjs','public/app.js','public/mission-ui.mjs','public/assets/relay-mark.svg'].map(get));
 assert.match(index,/<title>BLACKICE — Background Agent Workspace<\/title>/);
 assert.match(desktop,/title: 'BLACKICE'/);
 assert.match(app,/<span class="workspace-wordmark">[\s\S]*?<img\b[^>]*src="\/assets\/blackice-wordmark\.svg"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<span class="workspace-wordmark-label">BLACKICE<\/span><\/span>/,'the editable wordmark retains readable accessible text');
 assert.match(mission,/\bBLACKICE\b/);
 assert.match(icon,/viewBox="0 0 256 256"/);
 assert.match(icon,/BLACKICE/i);
 assert.match(icon,/<linearGradient\b[^>]*id="slab"/,'the replacement mark defines its black ice surface');
 assert.match(icon,/<path\b[^>]*fill="url\(#slab\)"/,'the mark uses the defined ice surface');
 assert.match(icon,/<g\b[^>]*id="branching-fracture"[^>]*stroke="url\(#fissure\)"/,'the branching fissure remains a distinct editable part of the mark');
 const ids=new Set([...icon.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
 for(const reference of icon.matchAll(/url\(#([^)]*)\)/g))assert.ok(ids.has(reference[1]),`the icon reference ${reference[1]} resolves within the SVG`);
 assert.ok(!icon.includes('d="M65 66h69'));
 assert.match(mission,/localStorage\.getItem\('relay\.mission\.draft'\)/,'chat drafts continue to use their stable storage key');
 assert.match(desktop,/getPath\('userData'\)/);
});

test('New chat is visibly labeled, accessible, and placed before chat navigation',async()=>{
 const [mission,css,experience,index]=await Promise.all(['public/mission-ui.mjs','public/relay-surface.css','public/blackice-experience.css','public/index.html'].map(get));
 const header=mission.match(/<header\b[^>]*class="conversation-header"[^>]*>([\s\S]*?)<\/header>/)?.[1];
 assert.ok(header,'the generated conversation header remains present regardless of template whitespace');
 const buttons=[...header.matchAll(/<button\b[^>]*data-mission-action="new-task"[^>]*>[\s\S]*?<\/button>/g)];
 assert.equal(buttons.length,1,'one New chat control belongs in the header');
 assert.ok(header.indexOf('data-mission-action="sidebar"')>buttons[0].index,'New chat precedes the conversation-list control');
 const button=buttons[0][0];
 assert.match(button,/\btitle="New chat"/);assert.match(button,/\baria-label="New chat"/);
 assert.match(button,/icon\('plus',\s*\d+\)/);assert.match(button,/<span>New chat<\/span>/);
 assert.doesNotMatch(button,/<button\b[^>]*(?:\s(?:hidden|disabled)(?:[\s=>])|aria-hidden="true")/);
 assert.match(css,/\.conversation-header>\.conversation-new-top\s*\{[^}]*\border:\s*-1/);
 assert.match(experience,/\.conversation-header>\.conversation-new-top\s*\{[^}]*\bwidth:\s*auto\s*!important/,'the labeled control overrides the old square icon width');
 assert.match(experience,/\.conversation-header>\.conversation-new-top>span\s*\{[^}]*\bdisplay:\s*inline\s*!important/);
 assert.ok(index.indexOf('href="/blackice-experience.css"')>index.indexOf('href="/relay-surface.css"'),'the label-preserving styles load after the original icon styles');
});
