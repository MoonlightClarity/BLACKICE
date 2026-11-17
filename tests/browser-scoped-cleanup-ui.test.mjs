import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { planningDOM } from './fixture-planning-dom.mjs';
import { browserScopedCleanupMarkup, cleanupGroups,
  createBrowserScopedCleanup } from '../public/next/workspaces/browser-scoped-cleanup-ui.mjs';

const tab = (tabId, conversationId, nodeId = 'research') => ({
  tabId, url:'https://fixture.invalid/' + tabId, title:tabId, documentId:tabId+':1',
  conversationId, owner:conversationId?{taskId:conversationId,nodeId,runId:conversationId+'-run'}:null,
  purpose:null,
});
const previewId = 'c'.repeat(64);

test('scoped cleanup panel previews exact task tabs and never dispatches global close or archive', async t => {
  const dom = planningDOM(t), notifications = [], calls = [];
  const status = { conversations: [{id:'a',title:'Research A',state:'active'}, {id:'b',title:'Coordination',state:'active'}],
    tabs: [tab('a1','a'), tab('a2','a','notes'), tab('b1','b'), tab('personal',null), { ...tab('shared',null), owner:{taskId:'connector',nodeId:'direct'} }] };
  dom.mount.innerHTML = '<button type="button" id="next-browser-cleanup-open">Clean up task</button>'
    + browserScopedCleanupMarkup();
  const controller = createBrowserScopedCleanup({mount:dom.mount,
    api:async(route,method,payload) => {
      calls.push({route,method,payload});
      if(route==='/api/browser/cleanup-preview') {
        const rows = status.tabs.filter(item=>item.conversationId===payload.conversationId
          && (payload.kind==='conversation'||item.owner.taskId===payload.taskId&&item.owner.nodeId===payload.nodeId))
          .map(item=>({tabId:item.tabId,title:item.title,url:item.url,documentId:item.documentId,
            eligible:item.tabId==='a1',...(item.tabId!=='a1'?{reason:'Unfinished task page.'}:{})}));
        return {scope:payload,previewId,total:rows.length,eligible:rows.filter(row=>row.eligible).length,
          protected:rows.filter(row=>!row.eligible).length,rows};
      }
      if(route==='/api/browser/cleanup') {
        assert.equal(payload.previewId,previewId);
        assert.deepEqual(payload.selectedTabIds,['a1']);
        assert.deepEqual(payload.scope,{kind:'conversation',conversationId:'a'});
        status.tabs = status.tabs.filter(item=>!payload.selectedTabIds.includes(item.tabId));
        return {closed:1,requested:1,remaining:1,remainingTabIds:['a2'],lateTabIds:[],
          failedTabs:[],persistenceVerified:true};
      }
      assert.fail('No global, archive, or other browser action may run: '+route);
    },
    async refresh(){controller.update(status);},
    notify:(message,error)=>notifications.push({message,error}),
  });
  t.after(()=>controller.destroy());
  controller.update(status);
  assert.equal(cleanupGroups(status,'a').length,2);
  await dom.click('#next-browser-cleanup-open');
  assert.equal(dom.$('#next-browser-cleanup-panel').hidden,false);
  const chooser=dom.$('#next-browser-cleanup-conversation');
  chooser.value='a';await chooser.dispatch('change');
  assert.equal(dom.$('#next-browser-cleanup-task').querySelectorAll('option').length,3);
  await dom.click('#next-browser-cleanup-preview');
  for(let i=0;i<100&&!dom.$('#next-browser-cleanup-list').querySelector('input[data-cleanup-id]');i++)await sleep(2);
  assert.equal(dom.$('#next-browser-cleanup-summary').textContent.includes('2 pages in scope'),true, JSON.stringify({summary:dom.$('#next-browser-cleanup-summary').textContent,calls,scope:dom.$('#next-browser-cleanup-task').value,convo:dom.$('#next-browser-cleanup-conversation').value}));
  assert.deepEqual(dom.$('#next-browser-cleanup-list').querySelectorAll('input[data-cleanup-id]').map(item=>item.dataset.cleanupId),['a1']);
  assert.equal(dom.$('#next-browser-cleanup-execute').disabled,false);
  await dom.click('#next-browser-cleanup-execute');
  for(let i=0;i<100&&!dom.$('#next-browser-cleanup-summary').textContent.includes('Closed 1 of 1');i++)await sleep(2);
  assert.match(dom.$('#next-browser-cleanup-summary').textContent,/1 remain/);
  assert.deepEqual(status.tabs.map(item=>item.tabId),['a2','b1','personal','shared']);
  assert.deepEqual(calls.map(item=>item.route),['/api/browser/cleanup-preview','/api/browser/cleanup']);
  assert.ok(notifications[0].message.includes('Closed 1 of 1'));
});

test('limited inspection requires deliberate per-page selection and displays the hidden-root limitation', async t => {
  const dom = planningDOM(t), calls = [];
  dom.mount.innerHTML = '<button type="button" id="next-browser-cleanup-open">Cleanup</button>' + browserScopedCleanupMarkup();
  const status = { conversations: [{ id: 'a', title: 'Research A', state: 'active' }],
    tabs: [tab('ordinary', 'a'), tab('personal', null)] };
  const controller = createBrowserScopedCleanup({ mount: dom.mount,
    api: async(route, method, payload) => {
      calls.push({route, payload});
      if (route === '/api/browser/cleanup-preview') return {
        scope: payload, previewId, total: 1, eligible: 1, reviewRequired: 1, protected: 0,
        rows: [{ tabId: 'ordinary', url: status.tabs[0].url, documentId: status.tabs[0].documentId,
          title: 'Ordinary div page', eligible: true, manualReviewRequired: true,
          inspectionWarning: 'No visible form detected; closed shadow roots on div/span may contain hidden drafts.' }],
      };
      if (route === '/api/browser/cleanup') return {
        closed: 1, requested: 1, remaining: 0, remainingTabIds: [], failedTabs: [],
        lateTabIds: [], persistenceVerified: true,
      };
      assert.fail('No global cleanup or archive route: ' + route);
    },
    async refresh() { controller.update(status); },
  });
  t.after(() => controller.destroy());
  controller.update(status);
  await dom.click('#next-browser-cleanup-open');
  const conversation = dom.$('#next-browser-cleanup-conversation');
  conversation.value = 'a'; await conversation.dispatch('change');
  await dom.click('#next-browser-cleanup-preview');
  for (let i = 0; i < 100 && !dom.$('#next-browser-cleanup-list').querySelector('input[data-cleanup-id]'); i++) await sleep(2);
  const input = dom.$('#next-browser-cleanup-list').querySelector('input[data-cleanup-id]');
  assert.ok(input, 'The ordinary page remains available for deliberate manual review.');
  assert.equal(input.checked, false, 'Limited inspection must not preselect a page for destructive cleanup.');
  assert.equal(dom.$('#next-browser-cleanup-execute').disabled, true);
  assert.match(dom.$('#next-browser-cleanup-summary').textContent, /manual review/i);
  assert.match(dom.$('#next-browser-cleanup-list').textContent, /closed shadow roots/i);
  input.checked = true; await input.dispatch('change');
  assert.equal(dom.$('#next-browser-cleanup-execute').disabled, false);
  await dom.click('#next-browser-cleanup-execute');
  for (let i = 0; i < 100 && calls.length < 2; i++) await sleep(2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].payload.selectedTabIds, ['ordinary']);
  assert.deepEqual(calls[1].payload.reviewedTabIds, ['ordinary']);
});

test('cleanup panel cannot infer a conversation from a shared connector owner', async t => {
  const dom = planningDOM(t);
  dom.mount.innerHTML = '<button id="next-browser-cleanup-open" type="button">Cleanup</button>' + browserScopedCleanupMarkup();
  let calls=0;
  const controller = createBrowserScopedCleanup({mount:dom.mount,api:async()=>{calls++;throw Error('must not call');}});
  t.after(()=>controller.destroy());
  controller.update({conversations:[],tabs:[{...tab('unassigned',null),owner:{taskId:'connection',nodeId:'direct'}}]});
  await dom.click('#next-browser-cleanup-open');
  assert.equal(dom.$('#next-browser-cleanup-preview').disabled,true);
  assert.equal(calls,0);
});
