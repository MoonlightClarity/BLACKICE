import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreDocument, scoreSkill} from './fixtures/document-skill-acceptance.mjs';

const doc = {target:'synthetic.pdf', marker:'ember-921', output:'ember-921', settled:true};
const finder = {op:'files.find',success:true,matches:[doc.target]};
const list = {op:'attachments.list',success:true};
const reader = {op:'workspace.read',target:doc.target,success:true,text:doc.marker};

test('document scorer credits direct or attachment-check-first discovery and same-target first read', () => {
  for (const events of [[finder,reader], [list,finder,reader]]) {
    const score = scoreDocument({...doc,events});
    assert.equal(score.passed,true);
    assert.equal(score.callsThroughUsable,events.length);
  }
  assert.equal(scoreDocument({...doc,attached:true,events:[list,{...reader,op:'attachments.read'}]}).passed,true);
});

test('document scorer rejects browser-first, shell, failed first read, and unsupported success claims', () => {
  const cases = [
    [[{op:'browser.tabs'},finder,reader],'early'],
    [[finder,{op:'workspace.run'},reader],'noShell'],
    [[finder,{...reader,success:false},reader],'firstReadWorked'],
    [[reader,finder],'foundBeforeRead'],
    [[finder],'firstReadWorked'],
  ];
  for (const [events,field] of cases) {
    const score = scoreDocument({...doc,events});
    assert.equal(score[field],false);
    assert.equal(score.passed,false);
  }
  assert.equal(scoreDocument({...doc,events:[finder,reader],output:'Need extraction first'}).answered,false);
});

const skill = {target:'fictional-inventory',marker:'count as MOSAIC',output:'count as MOSAIC',settled:true};
const search = {op:'skills.search',success:true,ids:[skill.target],metadataOnly:true};
const load = {op:'skills.read',id:skill.target,success:true,text:skill.marker};

test('skill scorer requires metadata retrieval, selected body, and applied marker, not a declaration', () => {
  assert.equal(scoreSkill({...skill,events:[search,load]}).passed,true);
  for (const events of [[search],[load,search],[{...search,metadataOnly:false},load],
      [{...search,ids:Array(11).fill(skill.target)},load],[search,{...load,id:'decoy'},load]]) {
    assert.equal(scoreSkill({...skill,events}).passed,false);
  }
  assert.equal(scoreSkill({...skill,events:[search,load],output:'I used the skill.'}).passed,false);
  assert.equal(scoreSkill({target:null,settled:true,events:[]}).passed,true);
  assert.equal(scoreSkill({target:null,settled:true,events:[load]}).passed,false);
});
