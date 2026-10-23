import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMissionDrafts } from '../public/draft-store.mjs';

test('changing Fast creates a new draft request while preserving other windows and reasoning', () => {
  const before = { conversationDrafts: { chat: { task: 'Original', attachmentIds: [], effort: 'max', serviceTier: 'fast' } } }, remote = structuredClone(before), local = structuredClone(before);
  remote.conversationDrafts.chat.pendingSend = { requestId: 'old-speed', config: { task: 'Original', serviceTier: 'fast' } };
  remote.conversationDrafts.other = { task: 'Another window', serviceTier: 'fast' };
  local.conversationDrafts.chat.serviceTier = 'default';
  const merged = mergeMissionDrafts(remote, before, local);
  assert.equal(merged.conversationDrafts.chat.serviceTier, 'default'); assert.equal(merged.conversationDrafts.chat.effort, 'max'); assert.equal(merged.conversationDrafts.chat.pendingSend, undefined);
  assert.deepEqual(merged.conversationDrafts.other, remote.conversationDrafts.other); assert.equal(before.conversationDrafts.chat.serviceTier, 'fast');
});

test('editing plan detail merges safely and invalidates an older submitted receipt without changing reasoning',()=>{
  const baseline={conversationDrafts:{chat:{task:'Task',attachmentIds:[],planDetail:'balanced',effort:'ultra'}}};
  const remote=structuredClone(baseline);remote.conversationDrafts.chat.pendingSend={requestId:'old-receipt',config:{task:'Task',planDetail:'balanced'}};remote.conversationDrafts.other={task:'Other window task',attachmentIds:[]};
  const local=structuredClone(baseline);local.conversationDrafts.chat.planDetail='detailed';
  const merged=mergeMissionDrafts(remote,baseline,local);assert.equal(merged.conversationDrafts.chat.planDetail,'detailed');assert.equal(merged.conversationDrafts.chat.effort,'ultra');assert.equal(merged.conversationDrafts.chat.pendingSend,undefined);assert.deepEqual(merged.conversationDrafts.other,remote.conversationDrafts.other);
});

test('Mission merges only this window’s changed fields without mutating or reverting other saved work',()=>{
  const baseline={cwd:'C:/first',desktop:false,conversationDrafts:{a:{task:'Original A',attachmentIds:[],model:'default'},b:{task:'Original B',attachmentIds:[]}}};
  const latest=structuredClone(baseline);latest.cwd='C:/other';latest.conversationDrafts.b={task:'Remote B',attachmentIds:['file-b'],effort:'ultra'};latest.conversationDrafts.c={task:'Remote C',attachmentIds:[]};
  const local=structuredClone(baseline);local.conversationDrafts.a.task='Local A';const merged=mergeMissionDrafts(latest,baseline,local);
  assert.equal(merged.cwd,'C:/other');assert.equal(merged.conversationDrafts.a.task,'Local A');assert.deepEqual(merged.conversationDrafts.b,latest.conversationDrafts.b);assert.deepEqual(merged.conversationDrafts.c,latest.conversationDrafts.c);assert.equal(baseline.conversationDrafts.a.task,'Original A');assert.equal(latest.conversationDrafts.a.task,'Original A');merged.conversationDrafts.b.task='changed';assert.equal(latest.conversationDrafts.b.task,'Remote B');
});

test('non-overlapping edits in one chat merge while explicit local resets remove only that override',()=>{
  const baseline={conversationDrafts:{chat:{task:'Original',attachmentIds:[],model:'default',context:{preset:'900k'},effort:'medium'}}},latest=structuredClone(baseline),local=structuredClone(baseline);
  latest.conversationDrafts.chat.task='Text from another window';latest.conversationDrafts.chat.attachmentIds=['file'];local.conversationDrafts.chat.model='provider::model';local.conversationDrafts.chat.effort='max';delete local.conversationDrafts.chat.context;
  const merged=mergeMissionDrafts(latest,baseline,local).conversationDrafts.chat;assert.equal(merged.task,'Text from another window');assert.deepEqual(merged.attachmentIds,['file']);assert.equal(merged.model,'provider::model');assert.equal(merged.effort,'max');assert.equal(merged.context,undefined);
});

test('opening an empty chat draft cannot replace a draft another window has already saved',()=>{
  const baseline={conversationDrafts:{}},latest={conversationDrafts:{chat:{task:'Remote message',attachmentIds:['remote-file'],effort:'ultra'}}},local={conversationDrafts:{chat:{task:'',attachmentIds:[],model:'provider::choice'}}};
  const merged=mergeMissionDrafts(latest,baseline,local).conversationDrafts.chat;assert.equal(merged.task,'Remote message');assert.deepEqual(merged.attachmentIds,['remote-file']);assert.equal(merged.effort,'ultra');assert.equal(merged.model,'provider::choice');
});

test('conditional send cleanup clears its own submitted draft but preserves a newer draft as a whole',()=>{
  const before={task:'Send this',attachmentIds:['file-a'],model:'one::model',pendingSend:{requestId:'accepted'}},baseline={conversationDrafts:{new:before}},cleared={conversationDrafts:{new:{task:'',attachmentIds:[]}}};
  const own=mergeMissionDrafts(baseline,baseline,cleared,{preserveNewerDrafts:true}).conversationDrafts.new;assert.deepEqual(own,{task:'',attachmentIds:[]});
  const newer={conversationDrafts:{new:{...before,task:'Next message',attachmentIds:['file-b'],model:'two::model'}}};
  assert.deepEqual(mergeMissionDrafts(newer,baseline,cleared,{preserveNewerDrafts:true}).conversationDrafts.new,newer.conversationDrafts.new);
});

test('malformed stored draft containers do not prevent a valid local message from being retained',()=>{
  for(const latest of [null,[],{conversationDrafts:null},{conversationDrafts:[]}])assert.equal(mergeMissionDrafts(latest,null,{conversationDrafts:{new:{task:'Local message',attachmentIds:[]}}}).conversationDrafts.new.task,'Local message');
});

test('new receipts retain their exact authored draft and subsequent edits cannot inherit another window’s receipt',()=>{
  const baseline={conversationDrafts:{new:{task:'First task',attachmentIds:[],model:'one::model'}}},remote={conversationDrafts:{new:{task:'Another task',attachmentIds:[],model:'two::model'}}},local=structuredClone(baseline);
  local.conversationDrafts.new.pendingSend={requestId:'first-receipt',mode:'start',config:{task:'First task',model:'one::model'}};
  const submitted=mergeMissionDrafts(remote,baseline,local).conversationDrafts.new;assert.equal(submitted.task,'First task');assert.equal(submitted.model,'one::model');assert.equal(submitted.pendingSend.config.task,submitted.task);
  const settings=structuredClone(baseline);settings.conversationDrafts.new.effort='ultra';const merged=mergeMissionDrafts({conversationDrafts:{new:submitted}},baseline,settings).conversationDrafts.new;assert.equal(merged.effort,'ultra');assert.equal(merged.pendingSend,undefined,'editing draft content/settings starts an independent request instead of recovering another window’s message');
});
test('a planning-mode edit invalidates another window’s old receipt while retaining its independent draft', () => {
  const baseline = { conversationDrafts: { chat: { task: 'Task', attachmentIds: [], planningMode: 'auto', effort: 'ultra' } } }, remote = structuredClone(baseline), local = structuredClone(baseline);
  remote.conversationDrafts.chat.pendingSend = { requestId: 'receipt-before-off', config: { task: 'Task', planningMode: 'auto' } }; remote.conversationDrafts.other = { task: 'Keep my other window', attachmentIds: [] };
  local.conversationDrafts.chat.planningMode = 'off'; const merged = mergeMissionDrafts(remote, baseline, local);
  assert.equal(merged.conversationDrafts.chat.planningMode, 'off'); assert.equal(merged.conversationDrafts.chat.effort, 'ultra'); assert.equal(merged.conversationDrafts.chat.pendingSend, undefined); assert.deepEqual(merged.conversationDrafts.other, remote.conversationDrafts.other);
});
