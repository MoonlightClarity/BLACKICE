import test from 'node:test';
import assert from 'node:assert/strict';
import { documentAnalysisContract } from '../lib/document-analysis-policy.mjs';

test('operational tasks using documents as evidence do not acquire document analysis contracts', () => {
  const requests = [
    'Set up and dogfood the existing job-search cronjob. Inspect the schedule, then search using the master resume. Evaluate job fit and verify each posting before submitting.',
    'Find jobs using my resume and verify them.',
    'Use the resume; do not delay applications to independently re-verify resume claims.',
    'Do not review the resume; find jobs.',
    'Do not read, review or analyze my resume.',
    'Configure a recurring compliance scan. Use the policy document for context and verify the alerts.',
    'Schedule a market report. Review leads and use the attached brief for background.'
  ];
  for (const task of requests) assert.equal(documentAnalysisContract({task}), null, task);
});

test('explicit document analysis still activates for dense source work', () => {
  for (const task of ['Analyze the attached resume.', 'Review my document.', 'Verify the following report.', 'Improve the candidate’s résumé.', 'Analyze Dylan’s resume.', 'Carefully review the 10-page résumé.', 'Compare these two reports.', 'Analyze the candidate leadership as presented in the resume.', 'Review all of the attached resume.', 'Review the first three pages of my resume.', 'Assess my experience using the attached resume.', 'Re-verify the resume.']) {
    const contract = documentAnalysisContract({task, attachments:[{kind:'pdf', pageCount:2}]});
    assert.ok(contract, task);
    assert.equal(contract.enforcePlan, true, task);
  }
  assert.equal(documentAnalysisContract({task:'Analyze the attached resume.', attachments:[{kind:'pdf',pageCount:2}]}).type, 'resume');
});

test('explicit references and continuing a prior analysis preserve document context', () => {
  assert.ok(documentAnalysisContract({task:'Analyze this.', attachments:[{kind:'pdf',pageCount:2}]}));
  assert.equal(documentAnalysisContract({task:'Do not review it.', attachments:[{kind:'pdf',pageCount:2}]}), null);
  const continued = documentAnalysisContract({
    task:'Continue and go deeper.',
    attachments:[{kind:'pdf',pageCount:2}],
    priorUserRequests:[{runId:'prior',text:'Analyze my resume.'}]
  });
  assert.equal(continued?.type, 'resume');
  assert.equal(continued.enforcePlan, true);
  assert.equal(documentAnalysisContract({task:'Verify it.', priorUserRequests:[{runId:'prior',text:'Search using my resume.'}]}), null);
  assert.equal(documentAnalysisContract({task:'Review my resume, but do not verify it.', attachments:[{kind:'pdf',pageCount:2}]}).analysisIntent, 'interpretive');
  assert.equal(documentAnalysisContract({task:'Do not just review the resume; improve it.', attachments:[{kind:'pdf',pageCount:2}]}).type, 'resume');
  assert.equal(documentAnalysisContract({task:'Read the attached resume. Review the report of prior applications, then submit new ones.', attachments:[{kind:'pdf',pageCount:3}]}).type, 'document');
});

test('a long operational prompt mentioning a resume is not treated as a pasted resume', () => {
  const task = 'Configure a cron job. Use the master resume to evaluate job fit. Verify postings and submit applications. ' + 'Record each result carefully. '.repeat(100);
  assert.ok(task.length > 2000);
  assert.equal(documentAnalysisContract({task}), null);
});
