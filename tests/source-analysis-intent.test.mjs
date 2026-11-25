import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitAnalyticalPerspective,isSourceAnalysisFollowup,resolveSourceAnalysisIntent,sourceAnalysisIntentInstruction} from '../lib/source-analysis-intent.mjs';

test('evaluator persona is a perspective, not an identity assigned to the résumé subject',()=>{
 for(const text of ['analyze the following resume as employer','analyze the resume as an employer','Analyze the résumé from an employer’s perspective','analyze the resume as a hiring manager','Analyze the resume as a recruiter']){
  const intent=resolveSourceAnalysisIntent({input:text,documentType:'resume'});
  assert.equal(intent.operation,'analysis');
  assert.equal(intent.subject,'candidate described in the résumé');
  assert.equal(intent.perspective.label,'hiring-side reviewer');
  assert.match(sourceAnalysisIntentInstruction(intent),/evaluate the candidate represented by the résumé from the viewpoint of someone considering hiring the candidate/i);
  assert.match(sourceAnalysisIntentInstruction(intent),/reader or evaluator’s viewpoint, not the identity/i);
  assert.equal(intent.showWorking,false);
 }
});
test('unspecified persona stays a general analysis; other roles remain readers, not subjects',()=>{
 const resume=resolveSourceAnalysisIntent({input:'analyze the following resume',documentType:'resume'});
 assert.equal(resume.perspective.role,'general-resume-review');
 const proposal=resolveSourceAnalysisIntent({input:'analyze this proposal as an investor',documentType:'document'});
 assert.equal(proposal.perspective.label,'investor');
 assert.equal(proposal.subject,'contents and claims of the supplied source');
 const teaching=resolveSourceAnalysisIntent({input:'analyze this essay as a teacher',documentType:'document'});
 assert.equal(teaching.perspective.label,'teacher');
});
test('analyze it inherits the same task objective; unrelated new requests do not',()=>{
 const first=resolveSourceAnalysisIntent({input:'analyze the following resume as employer',documentType:'resume'});
 const next=resolveSourceAnalysisIntent({input:'analyze it',documentType:'document',previous:first});
 assert.equal(isSourceAnalysisFollowup('analyze it'),true);
 assert.equal(isSourceAnalysisFollowup('Use the Reverse Outline skill. Analyze it.'),true,'a current explicit skill selection does not erase the follow-up');
 assert.equal(isSourceAnalysisFollowup('Use the Source-first analysis method skill. Analyze it.'),true);
 assert.equal(isSourceAnalysisFollowup('Use the Reverse Outline skill. Analyze the quarterly budget.'),false,'a new source must not inherit the old task');
 assert.equal(next.inheritedFromPrevious,true);
 assert.equal(next.subject,first.subject);
 assert.equal(next.perspective.label,first.perspective.label);
 assert.equal(next.originalRequest,first.originalRequest);
 assert.equal(next.currentRequest,'analyze it');
 assert.equal(isSourceAnalysisFollowup('analyze the quarterly budget'),false);
 assert.equal(isSourceAnalysisFollowup('analyze it as an investor'),true);
 const changed=resolveSourceAnalysisIntent({input:'analyze it as an investor',documentType:'document',previous:first});
 assert.equal(changed.perspective.label,'investor');
 assert.equal(changed.subject,first.subject);
 assert.match(sourceAnalysisIntentInstruction(changed),/Current same-task follow-up/);
 const fresh=resolveSourceAnalysisIntent({input:'analyze the quarterly budget',documentType:'document',previous:first});
 assert.equal(fresh.inheritedFromPrevious,false);
 assert.equal(fresh.subject,'contents and claims of the supplied source');
});
test('internal reconstruction remains internal unless the user explicitly requests it',()=>{
 assert.equal(resolveSourceAnalysisIntent({input:'analyze the resume',documentType:'resume'}).showWorking,false);
 assert.equal(resolveSourceAnalysisIntent({input:'analyze the resume and show the complete reverse outline',documentType:'resume'}).showWorking,true);
 assert.equal(resolveSourceAnalysisIntent({input:'analyze the resume briefly',documentType:'resume'}).showWorking,false);
});

test('an explicitly requested analytical method remains selected across same-task continuation',()=>{
 const first=resolveSourceAnalysisIntent({input:'Analyze the attached resume using structured analytic techniques',documentType:'resume'});
 assert.equal(first.explicitMethod,true);assert.equal(first.showWorking,false);
 const next=resolveSourceAnalysisIntent({input:'analyze it',documentType:'resume',previous:first});
 assert.equal(next.explicitMethod,true);assert.equal(next.originalRequest,first.originalRequest);
 assert.equal(resolveSourceAnalysisIntent({input:'Analyze resume as an employer',documentType:'resume'}).explicitMethod,false);
 assert.equal(resolveSourceAnalysisIntent({input:'Analyze resume with the Reverse Outline method',documentType:'resume'}).explicitMethod,true);
});
