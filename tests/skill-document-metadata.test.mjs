import test from 'node:test';
import assert from 'node:assert/strict';
import {skillDocumentTitle,skillApplicability} from '../lib/skill-document-metadata.mjs';

const base={description:'Base summary',activation:['judgment']};
const emptyFields={appliesWhen:'',scope:'',exclusions:''};

test('title and introductory purpose exclude later method instructions',()=>{
 const content='# Title\n\nA clear purpose.\n\n## Later\nLong instructions.';
 assert.equal(skillDocumentTitle(content),'Title');
 assert.deepEqual(skillApplicability(content,base),{
  description:'A clear purpose.',activation:['judgment'],activationDeclared:true,...emptyFields,
 });
 assert.equal(skillDocumentTitle('# Only heading\n'),'Only heading');
 assert.equal(skillApplicability('# Only heading\n',base).description,'Base summary');
});

test('front matter supplies explicit applicability, activation and scope',()=>{
 const content='---\ndescription: Specific purpose\nactivation: [judgment, resource-allocation]\nscope: Budget\n---\n# Name\n\nIntro';
 assert.equal(skillDocumentTitle(content),'Name');
 assert.deepEqual(skillApplicability(content,base),{
  description:'Specific purpose',activation:['judgment','resource-allocation'],activationDeclared:true,
  appliesWhen:'',scope:'Budget',exclusions:'',
 });
});

test('fenced headings are not document titles or introductory metadata',()=>{
 const content='~~~\n# Not a title\n~~~\n# Actual title ##\n\nPurpose';
 assert.equal(skillDocumentTitle(content),'Actual title');
 assert.equal(skillApplicability(content,base).description,'Base summary');
 const backticks=['```md','# Example title','```','# Real title'].join('\n');
 assert.equal(skillDocumentTitle(backticks),'Real title');
});

test('plain introductory prose remains usable without a Markdown title',()=>{
 const content='No heading or paragraph split.';
 assert.equal(skillDocumentTitle(content),null);
 assert.deepEqual(skillApplicability(content,base),{
  description:content,activation:['judgment'],activationDeclared:true,...emptyFields,
 });
 assert.equal(skillApplicability(content).activationDeclared,false);
 assert.deepEqual(skillApplicability(content).activation,[]);
});

test('an invalid declared activation does not silently inherit base activation',()=>{
 const content='---\nactivation: invalid\napplies_to: Useful cases\ndoes_not_apply_to: Obvious lookup\n---\n# Heading\n\nPurpose';
 assert.equal(skillDocumentTitle(content),'Heading');
 assert.deepEqual(skillApplicability(content,base),{
  description:'Useful cases',activation:[],activationDeclared:true,
  appliesWhen:'Useful cases',scope:'',exclusions:'Obvious lookup',
 });
});

test('explicit empty activation remains empty while absent descriptions use base metadata',()=>{
 const content='---\nactivation: []\n---\n# Inactive\n\n- Task list\n';
 assert.equal(skillDocumentTitle(content),'Inactive');
 assert.deepEqual(skillApplicability(content,{
  ...base,appliesWhen:'Substantive decision',scope:'Narrow domain',
 }),{
  description:'Base summary',activation:[],activationDeclared:true,
  appliesWhen:'Substantive decision',scope:'Narrow domain',exclusions:'',
 });
});
