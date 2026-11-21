import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessEngine } from '../lib/engine.mjs';
import { scoreHandoff } from './fixtures/document-skill-acceptance.mjs';
import { writeHandoffFixture } from './fixtures/synthetic-handoff.mjs';

const skillId = 'library-document-comparison';
// Match the complete bundled skill body at the actual delivery boundary.
const skillMarker = await readFile(new URL('../lib/skill-library/document-comparison.md', import.meta.url), 'utf8');

test('same synthetic handoff separates actual evidence, skill delivery, and calls', {timeout:20000}, async () => {
  const temporaryRoot = await realpath(tmpdir());
  const dir = await mkdtemp(path.join(temporaryRoot, 'blackice-handoff-ab-'));
  try {
    const cwd = path.join(dir, 'workspace'), inlineCwd = path.join(dir, 'inline-workspace');
    const fixture = await writeHandoffFixture(cwd, 'paired-offline-handoff-v1');
    await mkdir(inlineCwd); // The inline control cannot discover the fixture by searching its workspace.
    const {expected, targets} = fixture;
    const values = [expected.dispatchCode, expected.ticketCode, ...Object.values(expected.discrepancy)];
    for (const value of values) {
      assert.ok(!fixture.filePrompt.includes(value));
      assert.ok(fixture.inlinePrompt.includes(value));
    }

    async function run(label, {inline = false, skill = false} = {}) {
      const events = [];
      class Runtime extends EventEmitter {
        status() { return {connected:true,authenticated:true,defaultModel:'scripted-handoff'}; }
        async runAgent({onToolCall,onToolResultDelivered}) {
          async function call(name, args) {
            const toolCall = {name,arguments:args,callId:'fixture-'+label+'-'+events.length};
            const result = await onToolCall(toolCall);
            assert.equal(result.success,true,result.contentItems?.[0]?.text);
            onToolResultDelivered({call:toolCall,result});
            return JSON.parse(result.contentItems[0].text);
          }
          if (skill) {
            const found = await call('relay_skills',{action:'search',query:'compare document versions'});
            assert.ok(found.entries.some(entry => entry.id === skillId));
            assert.ok(found.entries.every(entry => !Object.hasOwn(entry,'content')));
            events.push({op:'skills.search',success:true,ids:found.entries.map(entry=>entry.id)});
            const {entry} = await call('relay_skills',{action:'read',id:skillId});
            assert.equal(entry.content,skillMarker);
            events.push({op:'skills.read',success:true,id:entry.id,text:entry.content});
          }
          let pdf,docx;
          if (inline) [pdf,docx] = fixture.inlinePrompt.split(/\n(?:PDF|DOCX):\n/).slice(1);
          else {
            const found = await call('relay_find_files',{query:'Orchard handoff',path:cwd});
            const matches = found.matches.map(row => row.path);
            assert.deepEqual([...matches].sort(),Object.values(targets).sort());
            events.push({op:'files.find',success:true,matches});
            for (const [format,target] of Object.entries(targets)) {
              const read = await call('relay_workspace',{action:'read',path:matches.find(p=>p===target)});
              const text = format === 'pdf' ? read.pages[0].text : read.content;
              events.push({op:'workspace.read',success:true,target,text});
              if (format === 'pdf') pdf=text; else docx=text;
            }
          }
          const capture = (text,prefix) => text.match(new RegExp('\\b'+prefix+'[A-F0-9]+'))?.[0];
          return {output:JSON.stringify({dispatchCode:capture(pdf,'DSP-'),ticketCode:capture(docx,'TKT-'),
            discrepancy:{pdf:capture(pdf,'P-'),docx:capture(docx,'W-')}}),threadId:'scripted-'+label};
        }
      }
      const engine = await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(dir,label),defaultCwd:inline?inlineCwd:cwd}).init();
      try {
        const workflow = {id:'synthetic-handoff',name:'Synthetic handoff',
          nodes:[{id:'input',type:'input',name:'Input'},{id:'agent',type:'agent',name:'Agent',model:'scripted-handoff',prompt:'Answer from the supplied handoff evidence.'},
            {id:'output',type:'output',name:'Output'}],
          edges:[{id:'in',source:'input',target:'agent'},{id:'out',source:'agent',target:'output'}],
          settings:{planningMode:'off',maxParallel:1}};
        const admission = engine.startRun({workflow,input:{task:inline?fixture.inlinePrompt:fixture.filePrompt,planningMode:'off',directoryMode:'off'}});
        let run;
        for(let i=0;i<800;i++) {
          run = engine.runs.get(admission.id);
          if(run?.settled) break;
          await delay(10);
        }
        assert.equal(run?.status,'completed',run?.error);
        const output = run.nodes?.agent?.output ?? run.output;
        assert.equal(typeof output,'string');
        return scoreHandoff({events,targets,expected,output,settled:run.settled,inline,skillMarker,skillReceipts:run.skillLoadReceipts});
      } finally { await engine.close(); }
    }
    const baseline = await run('scripted-no-load');
    const withSkill = await run('scripted-exact-skill',{skill:true});
    const control = await run('scripted-inline',{inline:true});
    assert.equal(baseline.groundedAnswer,true);
    assert.equal(baseline.firstUsefulTool,'files.find');
    assert.equal(baseline.earlyFileDiscovery,true);
    assert.equal(baseline.extraCalls,0);
    assert.equal(baseline.skillDelivered,false);
    assert.equal(withSkill.groundedAnswer,true);
    assert.equal(withSkill.firstActionAfterAttachmentCheck,'skills.search');
    assert.equal(withSkill.firstUsefulTool,'files.find');
    assert.equal(withSkill.earlyFileDiscovery,false);
    assert.equal(withSkill.skillDelivered,true);
    assert.equal(withSkill.extraCalls,2);
    assert.equal(withSkill.callsThroughEvidence,5);
    assert.equal(control.groundedAnswer,true);
    assert.equal(control.allCalls,0);
    assert.equal(control.skillDelivered,false);
    assert.equal(control.callsThroughEvidence,null);
    assert.equal(baseline.shellCalls+withSkill.shellCalls+control.shellCalls,0);
    const unsupported = scoreHandoff({events:[{op:'skills.read',id:skillId,success:true,text:skillMarker}],targets,expected,
      output:JSON.stringify(expected),settled:true,skillMarker});
    assert.equal(unsupported.correctAnswer,true);
    assert.equal(unsupported.groundedAnswer,false,'Correct-looking output cannot substitute for file receipts');
    assert.equal(unsupported.skillBodyReturned,true);
    assert.equal(unsupported.skillDelivered,false,'Returned body cannot substitute for provider delivery');
  } finally {
    const resolved = await realpath(dir);
    assert.equal(path.dirname(resolved),temporaryRoot,'Cleanup must stay in the fixture’s temporary directory');
    assert.match(path.basename(resolved),/^blackice-handoff-ab-/);
    await rm(resolved,{recursive:true,force:true});
  }
});
