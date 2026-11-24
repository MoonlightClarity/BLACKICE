import test from 'node:test';
import assert from 'node:assert/strict';
import { googlePickerRows, savedGoogleModel } from '../lib/google-account-chat.mjs';
import { chatOptionChoices, validateChatOptions } from '../public/next/chat/options-model.mjs';

for (const effort of ['high','medium','low']) {
  test('Google '+effort+' keeps its variant when another provider supplied effort and tier', () => {
    const id = 'gemini-3.8-flash-'+effort;
    const models = googlePickerRows({source:'Google Antigravity', models:[{id,name:'Gemini '+effort}]});
    const route = 'google-account::'+id;
    const status = {providers:[],models,defaultModel:route};
    for (const model of [route,'default']) {
      const raw = {model,effort:'max',serviceTier:'fast'};
      const choices = chatOptionChoices(status,raw);
      assert.ok(choices.models.some(row => row.id===route && !row.disabled));
      assert.deepEqual(choices.efforts.map(row=>row.label),[effort[0].toUpperCase()+effort.slice(1)+' (selected model)']);
      assert.equal(choices.tiers.find(row=>row.id==='fast').disabled,true);
      assert.equal(validateChatOptions(status,raw).effort,'default');
      assert.equal(validateChatOptions(status,raw).serviceTier,'default');
      assert.equal(raw.effort,'max');
    }
    assert.equal(savedGoogleModel('google_account_'+id+'_12345678-1234-1234-1234-123456789abc'),route);
    assert.equal(savedGoogleModel('antigravity_historical'),undefined);
  });
}
