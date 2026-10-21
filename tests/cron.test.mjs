import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCron,cronOccurrences,cronPreview} from '../lib/cron.mjs';

const times=(expression,timezone,after,count=3)=>cronOccurrences({expression,timezone},{after:Date.parse(after),count}).map(at=>new Date(at).toISOString());

test('five-field cron follows actual local weekdays, minute boundaries, names and numeric Sunday aliases',()=>{
  assert.deepEqual(times('0 9 * * mon-fri','America/New_York','2026-10-16T12:30:59Z'),['2026-10-16T13:00:00.000Z','2026-10-19T13:00:00.000Z','2026-10-20T13:00:00.000Z']);
  assert.equal(times('0 9 * * MON-FRI','America/New_York','2026-10-16T13:00:00Z',1)[0],'2026-10-19T13:00:00.000Z');
  assert.deepEqual(times('*/15 8-10/2 * jan,oct 0,7','UTC','2026-10-17T23:59:59Z',5),['2026-10-18T08:00:00.000Z','2026-10-18T08:15:00.000Z','2026-10-18T08:30:00.000Z','2026-10-18T08:45:00.000Z','2026-10-18T10:00:00.000Z']);
  assert.equal(times('* * * * *','UTC','2026-10-16T13:00:00.001Z',1)[0],'2026-10-16T13:01:00.000Z');
});

test('restricted month-day and weekday use OR, while wildcard day steps retain their intersection',()=>{
  assert.deepEqual(times('0 0 1 * MON','UTC','2026-10-19T00:00:00Z',3),['2026-10-26T00:00:00.000Z','2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z']);
  assert.deepEqual(times('0 0 */2 * MON','UTC','2026-10-16T00:00:00Z',3),['2026-10-19T00:00:00.000Z','2026-11-09T00:00:00.000Z','2026-11-23T00:00:00.000Z']);
  assert.equal(times('0 0 30 FEB MON','UTC','2026-02-01T00:00:00Z',1)[0],'2026-02-02T00:00:00.000Z','an otherwise impossible DOM is valid when restricted weekday matches by OR');
});

test('calendar schedules skip nonexistent spring minutes without shifting the requested hour',()=>{
  assert.deepEqual(times('30 2 * * *','America/New_York','2026-03-07T08:00:00Z',2),['2026-03-09T06:30:00.000Z','2026-03-10T06:30:00.000Z']);
  assert.equal(times('15 2 * * *','Australia/Lord_Howe','2026-10-03T00:00:00Z',1)[0],'2026-10-04T15:15:00.000Z');
});

test('repeated DST minutes produce distinct ordered receipts, including a half-hour fold',()=>{
  assert.deepEqual(times('30 1 * * *','America/New_York','2026-11-01T04:00:00Z'),['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z','2026-11-02T06:30:00.000Z']);
  assert.equal(times('30 1 * * *','America/New_York','2026-11-01T05:45:00Z',1)[0],'2026-11-01T06:30:00.000Z');
  assert.deepEqual(times('45 1 * * *','Australia/Lord_Howe','2026-04-04T13:00:00Z',2),['2026-04-04T14:45:00.000Z','2026-04-04T15:15:00.000Z']);
  assert.deepEqual(times('30 2 * * *','Europe/Berlin','2026-10-24T23:00:00Z',2),['2026-10-25T00:30:00.000Z','2026-10-25T01:30:00.000Z']);
});

test('offsets, skipped calendar days and century leap rules do not become fixed 24-hour intervals',()=>{
  assert.equal(times('0 9 * * *','Asia/Kathmandu','2026-10-16T00:00:00Z',1)[0],'2026-10-16T03:15:00.000Z');
  assert.equal(times('0 9 * * *','Asia/Kolkata','2026-10-16T00:00:00Z',1)[0],'2026-10-16T03:30:00.000Z');
  assert.equal(times('0 9 30 DEC *','Pacific/Apia','2011-12-29T12:00:00Z',1)[0],'2012-12-29T19:00:00.000Z');
  assert.equal(times('0 9 29 FEB *','UTC','2096-03-01T00:00:00Z',1)[0],'2104-02-29T09:00:00.000Z');
});

test('validation rejects malformed fields, impossible dates, unsupported syntax and unbounded preview requests',()=>{
  for(const expression of ['* * * *','0 * * * * *','0 24 * * *','60 * * * *','0 0 0 * *','0 0 * 13 *','0 0 * * 8','*/0 * * * *','*/61 * * * *','0 0 5-1 * *','0 0 * * FUNDAY','0 0 L * *','0 0 * * ?','0 0 * * MON#2','0 0 * * * echo hi','0,,1 * * * *','0/ * * * *','0 0 30 FEB *','0 0 31 APR */2','x'.repeat(257)])assert.throws(()=>parseCron(expression,'UTC'),{code:'INVALID_CRON'},expression);
  for(const timezone of ['',null,'No/Such_Zone','+01:00','UTC\0','America/New_York;run'])assert.throws(()=>parseCron('0 9 * * *',timezone),{code:'INVALID_CRON'});
  for(const count of [0,11,1e100,'5',NaN])assert.throws(()=>cronOccurrences({expression:'* * * * *',timezone:'UTC'},{count}),{code:'INVALID_CRON'});
  assert.throws(()=>cronOccurrences({expression:'* * * * *',timezone:'UTC'},{after:NaN}),{code:'INVALID_CRON'});
});

test('previews expose normalized trigger, real timestamps and explicit DST behavior without starting work',()=>{
  const preview=cronPreview({expression:'  0 9 * * mon-fri ',timezone:'America/New_York'},{after:Date.parse('2026-10-16T12:00:00Z'),count:2});
  assert.deepEqual(preview.trigger,{type:'cron',expression:'0 9 * * MON-FRI',timezone:'America/New_York'});assert.equal(preview.nextAt,Date.parse('2026-10-16T13:00:00Z'));assert.equal(preview.occurrences.length,2);assert.match(preview.occurrences[0].local,/Oct 16, 2026.*9:00 AM/);assert.deepEqual(preview.semantics,{missingTimes:'skip',repeatedTimes:'twice',dayMatch:'OR'});
  const folded=cronPreview({expression:'30 1 * * *',timezone:'America/New_York'},{after:Date.parse('2026-11-01T04:00:00Z'),count:2});assert.notEqual(folded.occurrences[0].local,folded.occurrences[1].local,'offset names distinguish repeated local wall minutes');
});
