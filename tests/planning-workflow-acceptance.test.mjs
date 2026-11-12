import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

// Explicit contract-adapter acceptance. The real Engine runs the owner directly;
// the controller opts this fixture into retained low-level contract adapters. It
// does not synthesize an automatic cycle, install an Engine guard, or certify the
// provider's answer. The test worker never receives the destination's in-process
// oracle. It sees
// the same public native planning inputs and browser/workspace receipts as a
// provider. The controller compares host outcomes with the independent oracle.
const childMode = process.versions.electron && process.argv.includes('--workshop-acceptance-child');
const cases = [
  { id: 'cohesive', label: 'an explicitly authored contract verifies a real enrollment through retained host adapters', count: 1 },
  { id: 'recovery', label: 'real custom selection, validation correction and lost-response reconciliation preserve one effect per outcome', count: 4 },
  { id: 'audit', label: 'an explicitly audit-only preference finding preserves the authorized enrollment and actual submitted text', count: 1 },
  { id: 'twenty', label: 'twenty confirmed new outcomes exclude prior records and alias forms', count: 20 },
  { id: 'text-only', label: 'a visible received message without a supported receipt binding remains honestly unconfirmed', count: 1 },
  { id: 'native-text', label: 'an ordinary native POST text confirmation is tied to the actual submitted form and navigation', count: 1 },
  { id: 'final-failure', label: 'a failed operational provider preserves verified receipts without publishing an unreturned claim', count: 1 },
  { id: 'dependencies', label: 'parallel browser and source observations preserve complete-current-source commit prerequisites', count: 1 },
  { id: 'resume', label: 'cancellation after an accepted external effect resumes through actual history without replay', count: 1 },
];

function payload(receipt) {
  for (const item of receipt?.contentItems || []) {
    if (item.type !== 'inputText' || typeof item.text !== 'string') continue;
    try {
      const value = JSON.parse(item.text);
      if (value && !String(value.type || '').startsWith('planning.')) return value;
    } catch { /* A following item may be structured. */ }
  }
  return null;
}
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, message, timeoutMs = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const plainPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
const elements = snapshot => (snapshot?.frames || []).flatMap(frame => frame.elements || []);
const records = snapshot => (snapshot?.frames || []).flatMap(frame => frame.semanticRecords || []);
const forms = snapshot => (snapshot?.frames || []).flatMap(frame => frame.forms || []);
const pageText = snapshot => (snapshot?.frames || []).map(frame => frame.text || '').join('\n');
const errorText = receipt => receipt?.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') || JSON.stringify(receipt);
function operationReceipt(receipt) {
  for (const item of receipt?.contentItems || []) if (item.type === 'inputText') {
    try { const value = JSON.parse(item.text); if (value?.type === 'planning.operation') return value; } catch {}
  }
  return null;
}
const requestFor = (origin, count, audit = false) => `Using demo-profile.json, enroll the demo participant in ${count} new workshops at ${origin}. Avoid existing enrollments and report the confirmations.`
  + (audit ? ' For this dedicated audit case, treat the profile note preference as audit-only: report any deviation and continue the authorized enrollment.' : '');

function initialContract({ request, origin, cwd, count, audit = false }) {
  return {
    contractVersion: 2,
    goal: request,
    criteria: [{ id: 'new-enrollments', kind: 'external-confirmation', description: 'The destination confirms each distinct new enrollment.', targetCount: count }],
    workItems: [{
      id: 'enroll-participant', title: 'Complete the requested new enrollments',
      objective: 'Read the supplied profile and existing records, inspect the available workshops, and complete and verify the requested new enrollments.',
      owner: 'agent', resourceKeys: ['origin:' + origin, 'workspace:' + plainPath(cwd)],
      effects: ['observe', 'interact', 'commit', 'opaque'], dependsOn: [], criterionIds: ['new-enrollments'],
    }],
    instructions: audit ? [{ id: 'no-unrequested-limitation', text: 'The supplied profile note preference is audit-only: report deviations while completing the authorized enrollment.', handling: 'audit' }] : [],
  };
}

function publicBinding(historyRecord, form, profile, rejection) {
  assert.ok(historyRecord?.attributes, 'A real browser observation must supply the receipt attributes before binding.');
  const entries = Object.entries(historyRecord.attributes);
  const field = predicate => {
    const candidates = entries.filter(([key, value]) => predicate(key, value));
    assert.equal(candidates.length, 1, 'An observed receipt field must be unambiguous: ' + JSON.stringify(candidates));
    return candidates[0][0];
  };
  const status = field((key, value) => value === 'confirmed');
  const outcomeId = field((key, value) => value.startsWith(profile.participantId + ':'));
  const destination = field((key, value) => /^https?:/.test(value) && value.includes('/enroll'));
  const participant = field((key, value) => value === profile.participantId);
  const email = field((key, value) => value === profile.email);
  const prior = field((key, value) => value === 'true' && key.includes('prior'));
  const controlNames = new Set(form.fields.map(control => control.name));
  assert.ok(controlNames.has('participantId') && controlNames.has('email'));
  const binding = {
    version: 1, format: 'dom', resourceKey: 'origin:' + new URL(form.action).origin,
    // This selector is derived from the attribute actually returned by the
    // public browser read. The initial accepted Plan contains no selector.
    record: '[' + status + ']', status, confirmedValues: ['confirmed'], outcomeId,
    destination, history: true, prior: { field: prior, values: ['true'] },
    identity: [{ field: participant, formField: 'participantId' }, { field: email, formField: 'email' }],
  };
  if (rejection) {
    const value = rejection.attributes[status];
    assert.equal(value, 'validation-rejected', 'The rejection value must come from the actual server response displayed in the page.');
    binding.absentValues = [value];
  }
  return binding;
}

async function runElectronCase({ directory, mode }) {
  const { BrowserWindow } = await import('electron');
  const { HarnessEngine } = await import('../lib/engine.mjs');
  const { createPlanningWorkerGuard, wrapPlanningToolHandler } = await import('../lib/planning-awareness.mjs');
  const { createWorkspaceToolHandler } = await import('../lib/workspace-tools.mjs');
  const { TaskStateStore, createTaskToolHandler } = await import('../lib/task-state.mjs');
  const { PlanningBrowserStore } = await import('../lib/planning-browser.mjs');
  const { PlanningBrowserRuntime } = await import('../lib/planning-browser-runtime.mjs');
  const { TaskViability } = await import('../lib/task-viability.mjs');
  const { ResponseCycleService } = await import('../lib/response-cycle.mjs');
  const { createMissionWorkflow } = await import('../public/mission-model.mjs');
  const { ElectronBrowserDriver } = await import('../desktop/browser-driver.mjs');
  const { BrowserWorkspace, createBrowserToolHandler } = await import('../lib/browser.mjs');
  const { createWorkshopPortal } = await import('./fixtures/planning-workshop-portal.mjs');
  const { readContractJournal, contractRuntimeView } = await import('../lib/planning-contract-runtime.mjs');
  const configuration = cases.find(item => item.id === mode);
  assert.ok(configuration, 'Unknown disposable acceptance mode.');
  const cwd = path.join(directory, 'workspace');
  await mkdir(cwd, { recursive: true });
  const report = { mode, onlyLoopback: true, liveProfileAccessed: false, checks: [], calls: [], stages: [], planningResponses: [], normalizerChecks: 0 };
  const check = (name, operation) => { operation(); report.checks.push(name); };
  let portal, foreign, tasks, store, driver, browser, engine, runner, viability, service;
  let runId, activeOptions, deliveredProfile, snapshot, tabId;
  let callSequence = 0, acceptedContract, boundEpoch, initialEpoch;
  const seenConfirmed = new Set(), priorIds = new Set(), knownCanonical = new Set();
  const request = () => requestFor(portal.origin, configuration.count, mode === 'audit');
  const observation = { initialPlan: null, boundPlan: null, operationalTurns: 0, callEpochs: [], bindingCount: 0, rejectedReplay: null, ruleFinding: null };
  const parallelStarted = deferred(), parallelRelease = deferred();
  const commitAccepted = deferred(), commitRelease = deferred();
  try {
    portal = await createWorkshopPortal({ seed: 'production-contract-' + mode, newCount: configuration.count,
      existingCount: ['text-only', 'native-text'].includes(mode) ? 0 : 2, pageSize: 5,
      recoverableValidation: mode === 'recovery', loseReceipt: ['recovery', 'resume'].includes(mode),
      auditPreference: mode === 'audit',
      receiptStyle: ['text-only', 'native-text'].includes(mode) ? mode : 'attributes',
      beforeRequest: async value => {
        if (mode === 'dependencies' && value.path === '/workshops' && value.query.parallel === '1') {
          parallelStarted.resolve(); await parallelRelease.promise;
        }
      },
      afterCommit: async value => {
        if (mode === 'resume') { commitAccepted.resolve(value); await commitRelease.promise; }
      } });
    foreign = await createWorkshopPortal({ seed: 'outside-authority-' + mode, newCount: 1, recoverableValidation: false, loseReceipt: false });
    const artifacts = await portal.writeArtifacts(path.join(directory, 'private-oracle'));
    await writeFile(path.join(cwd, 'demo-profile.json'), await readFile(artifacts.profilePath));
    acceptedContract = initialContract({ request: request(), origin: portal.origin, cwd, count: configuration.count, audit: mode === 'audit' });
    if (mode === 'dependencies') {
      acceptedContract.criteria.push({ id: 'current-profile', kind: 'source-coverage',
        description: 'Read the complete current participant profile before committing an enrollment.',
        resourceKey: 'path:' + plainPath(path.join(cwd, 'demo-profile.json')) });
      acceptedContract.workItems[0].dependsOn = ['inspect-profile'];
      // Deliberately list the dependent item first. Dependencies come from
      // declared evidence, never the array position.
      acceptedContract.workItems.push({ id: 'inspect-profile', title: 'Inspect the current participant profile',
        objective: 'Read the complete current source and preserve its observed version.', owner: 'agent',
        resourceKeys: ['workspace:' + plainPath(cwd)], effects: ['observe'], dependsOn: [], criterionIds: ['current-profile'] });
    }
    tasks = await new TaskStateStore({ dataDir: directory }).init();
    store = await new PlanningBrowserStore({ dataDir: directory }).init();
    await mkdir(path.join(directory, 'browser'), { recursive: true });
    await mkdir(path.join(directory, 'downloads'), { recursive: true });
    driver = await new ElectronBrowserDriver({ dataDir: path.join(directory, 'browser'), downloadDir: path.join(directory, 'downloads') }).init();
    browser = new BrowserWorkspace({ driver });
    const settings = { defaultModel: 'fixture-contract-provider', defaultEffort: 'low', executionGuardrails: false, runTimeoutMs: null };

    async function call(name, args, { allowedFailure = false } = {}) {
      const callId = 'workshop-' + mode + '-' + (++callSequence);
      const toolCall = { name, arguments: args, callId };
      let receipt;
      try { receipt = await activeOptions.onToolCall(toolCall); }
      catch (error) {
        report.calls.push({ callId, name, action: args.action, callbackRejected: true, code: error.code || null, message: error.message });
        throw error;
      }
      const body = payload(receipt);
      await activeOptions.onToolResultDelivered?.({ call: toolCall, result: receipt });
      const planning = operationReceipt(receipt);
      // Test observations do not acknowledge state on the provider's behalf.
      const state = await tasks.get(engine.listRuns()[0].taskId);
      observation.callEpochs.push({ callId, name, action: args.action, epoch: state.contract?.planEpoch });
      report.calls.push({ callId, name, action: args.action, success: receipt.success, code: receipt.code || body?.code || null,
        ...(planning ? { planning } : {}),
        ...(name === 'relay_browser' && body?.frames ? { browserObservation: {
          url: body.url, documentId: body.documentId,
          frames: body.frames.map(frame => ({ validation: frame.validation || [], semanticRecords: frame.semanticRecords || [] })),
        } } : {}),
      });
      if (!allowedFailure) assert.equal(receipt.success, true, name + '.' + args.action + ': ' + errorText(receipt));
      return { receipt, body, callId, planning };
    }
    async function task(args, options) { return (await call('relay_task', args, options)).body; }
    async function page(args, options) {
      const result = await call('relay_browser', { browser: 'relay', ...(tabId ? { tabId } : {}), ...args }, options);
      if (result.receipt.success && result.body?.frames) { snapshot = result.body; tabId = snapshot.tabId; }
      return result;
    }
    const ref = name => {
      const found = elements(snapshot).find(element => element.name === name);
      assert.ok(found?.ref, 'The actual page must expose ' + name + ': ' + pageText(snapshot).slice(0, 700));
      return found.ref;
    };
    const act = (action, name, extra = {}, options) => page({ action, ...(name ? { ref: ref(name) } : {}),
      expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId, ...extra }, options);
    const navigate = url => page({ action: tabId ? 'navigate' : 'open', url });
    async function settle(predicate, label) {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (predicate(snapshot)) return snapshot;
        await page({ action: 'read' });
        if (predicate(snapshot)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.fail('The real rendered page did not reach ' + label + ': ' + pageText(snapshot).slice(0, 1200));
    }
    function observeRecords() {
      for (const record of records(snapshot)) {
        const attrs = record.attributes || {};
        if (attrs['data-receipt-status'] !== 'confirmed') continue;
        const id = attrs['data-workshop-id'];
        if (attrs['data-receipt-prior'] === 'true') priorIds.add(id);
        else if (id) seenConfirmed.add(id);
      }
    }
    async function inspectHistory() {
      await navigate(portal.origin + '/enrollments');
      let firstRecord;
      for (let pages = 0; pages < 20; pages++) {
        firstRecord ||= records(snapshot).find(record => record.attributes?.['data-receipt-status'] === 'confirmed');
        observeRecords();
        const next = elements(snapshot).find(element => element.name === 'Next page');
        if (!next) return firstRecord;
        await act('click', 'Next page');
      }
      assert.fail('The bounded public enrollment pagination did not terminate.');
    }
    async function bind(historyRecord, form, rejection) {
      const current = await task({ action: 'read' });
      assert.ok(Number.isSafeInteger(current.revision));
      const contract = copy(current.contract);
      delete contract.planEpoch;
      contract.criteria.find(item => item.id === 'new-enrollments').receiptBinding = publicBinding(historyRecord, form, deliveredProfile, rejection);
      const saved = await task({ action: 'plan', expectedRevision: current.revision, contract });
      boundEpoch = saved.contract.planEpoch;
      observation.boundPlan = copy(saved.contract);
      acceptedContract = copy(saved.contract); delete acceptedContract.planEpoch;
      observation.bindingCount++;
      await task({ action: 'focus', expectedPlanEpoch: boundEpoch, workItemId: 'enroll-participant' });
    }
    async function bindNativeText(status, form) {
      assert.ok(status?.selector && status.text, 'A plain confirmation binding must come from the actual returned semantic status record.');
      const names = new Set(form.fields.map(field => field.name));
      assert.ok(names.has('participantId') && names.has('workshopId'));
      const current = await task({ action: 'read' });
      const contract = copy(current.contract);
      delete contract.planEpoch;
      contract.criteria.find(item => item.id === 'new-enrollments').receiptBinding = {
        version: 1, format: 'dom-text', resourceKey: 'origin:' + new URL(form.action).origin,
        record: status.selector, confirmedValues: [status.text.replace(/\s+/g, ' ').trim()],
        history: false, outcomeFields: ['participantId', 'workshopId'],
      };
      const saved = await task({ action: 'plan', expectedRevision: current.revision, contract });
      boundEpoch = saved.contract.planEpoch;
      observation.boundPlan = copy(saved.contract);
      acceptedContract = copy(saved.contract); delete acceptedContract.planEpoch;
      observation.bindingCount++;
      await task({ action: 'focus', expectedPlanEpoch: boundEpoch, workItemId: 'enroll-participant' });
    }
    async function profile() {
      const read = await call('relay_workspace', { action: 'read', path: 'demo-profile.json' });
      assert.equal(typeof read.body?.content, 'string');
      deliveredProfile = JSON.parse(read.body.content.split('\n').map(line => line.replace(/^\d+: /, '')).join('\n'));
      assert.match(deliveredProfile.email, /@example\.test$/);
    }
    async function exerciseSourceDependencies() {
      await task({ action: 'focus', expectedPlanEpoch: initialEpoch, workItemId: 'inspect-profile' });
      const first = await call('relay_workspace', { action: 'read', path: 'demo-profile.json', startLine: 1, lineCount: 3 });
      const repeated = await call('relay_workspace', { action: 'read', path: 'demo-profile.json', startLine: 1, lineCount: 3 });
      const partial = await task({ action: 'read' });
      assert.equal(partial.contractRuntime.criteria.find(item => item.id === 'current-profile').satisfied, false);
      const deniedAssessment = await call('relay_task', { action: 'assess', expectedPlanEpoch: initialEpoch,
        workItemId: 'inspect-profile', criterionId: 'current-profile', judgment: 'satisfied',
        evidenceIds: repeated.planning.evidenceIds, note: 'The provider claims that the partial source was sufficient.' }, { allowedFailure: true });
      assert.equal(deniedAssessment.receipt.success, false, 'A model assertion cannot promote incomplete source coverage.');
      observation.partialCoverageRejected = deniedAssessment.receipt.code || deniedAssessment.body?.code;
      assert.equal(observation.partialCoverageRejected, 'TASK_CONTRACT_EVIDENCE_REQUIRED');
      const afterAssessment = await task({ action: 'read' });
      assert.equal(afterAssessment.contractRuntime.criteria.find(item => item.id === 'current-profile').satisfied, false,
        'The rejected assessment leaves the actual host source-coverage criterion unsatisfied.');
      // A real browser navigation is held by the destination. The unrelated
      // source read must return before that destination is released.
      let browserFinished = false;
      const browserRead = navigate(portal.origin + '/workshops?parallel=1').then(value => { browserFinished = true; return value; });
      await bounded(parallelStarted.promise, 'The actual browser request did not reach its disposable server barrier.');
      try {
        const independent = await bounded(call('relay_workspace', { action: 'read', path: 'demo-profile.json', startLine: 1, lineCount: 3 }),
          'Independent source observation was blocked behind the browser operation.');
        assert.equal(browserFinished, false);
        observation.parallelObservation = { sourceCallId: independent.callId, browserPendingAtSourceReturn: true };
      } finally { parallelRelease.resolve(); }
      observation.parallelObservation.browserCallId = (await browserRead).callId;
      const links = elements(snapshot).filter(element => /^Demo workshop /.test(element.name || '') && element.href);
      assert.ok(links.length);
      await navigate(links[0].href);
      await task({ action: 'focus', expectedPlanEpoch: initialEpoch, workItemId: 'enroll-participant' });
      const early = await act('click', 'Request enrollment', {}, { allowedFailure: true });
      assert.equal(early.receipt.success, false, 'A true incomplete-source prerequisite must block commit before browser dispatch.');
      assert.match(errorText(early.receipt), /TASK_CONTRACT_PREREQUISITE/);
      observation.dependencyDenied = early.callId;
      // The controller simulates a concurrent external source edit. No bytes
      // are supplied to the provider outside its ordinary workspace read.
      const changed = JSON.parse(await readFile(path.join(cwd, 'demo-profile.json'), 'utf8'));
      changed.phone = '+1 202 555 0102';
      await writeFile(path.join(cwd, 'demo-profile.json'), JSON.stringify(changed, null, 2) + '\n');
      await task({ action: 'focus', expectedPlanEpoch: initialEpoch, workItemId: 'inspect-profile' });
      await call('relay_workspace', { action: 'read', path: 'demo-profile.json', startLine: 4, lineCount: 100 });
      const mixed = await task({ action: 'read' });
      assert.equal(mixed.contractRuntime.criteria.find(item => item.id === 'current-profile').satisfied, false,
        'Ranges from different observed source versions cannot be combined into complete coverage.');
      await profile();
      const complete = await task({ action: 'read' });
      assert.equal(complete.contractRuntime.criteria.find(item => item.id === 'current-profile').satisfied, true);
      assert.equal(complete.contract.planEpoch, initialEpoch, 'Reading evidence and observing a new source version do not rewrite the intent contract.');
      observation.sourceCoverage = { partialEvidenceIds: first.planning.evidenceIds,
        versionMixRejected: true, completeCurrentSource: true };
      await task({ action: 'focus', expectedPlanEpoch: initialEpoch, workItemId: 'enroll-participant' });
    }
    async function catalog() {
      await navigate(portal.origin + '/workshops');
      const links = [];
      for (let pages = 0; pages < 20; pages++) {
        for (const element of elements(snapshot)) {
          if (/^Demo workshop /.test(element.name || '') && element.href) links.push({ title: element.name, url: element.href });
        }
        const next = elements(snapshot).find(element => element.name === 'Next page');
        if (!next) break;
        await act('click', 'Next page');
      }
      assert.ok(links.length >= configuration.count, 'The provider must discover workshop links in actual page results.');
      return links;
    }
    async function fillProfile({ audit = false, deferLocation = false } = {}) {
      if (!observation.sameFieldCorrection) {
        await act('fill', 'First name', { text: deliveredProfile.firstName + ' draft' });
        observation.sameFieldCorrection = true;
      }
      await act('fill', 'First name', { text: deliveredProfile.firstName });
      await act('fill', 'Last name', { text: deliveredProfile.lastName });
      await act('fill', 'Email', { text: deliveredProfile.email });
      await act('fill', 'Phone', { text: deliveredProfile.phone });
      await act('fill', 'Location', { text: deliveredProfile.location });
      if (!observation.nativeSelectProbe) {
        const incorrectNativeSelect = await act('select', 'Location', { value: deliveredProfile.location }, { allowedFailure: true });
        observation.nativeSelectProbe = { callId: incorrectNativeSelect.callId, body: incorrectNativeSelect.body };
        assert.equal(incorrectNativeSelect.receipt.success, false);
        assert.match(errorText(incorrectNativeSelect.receipt), /not a native select|not.*select|select element/i,
          'A real custom control must reject the native-select API before fallback.');
        assert.ok(incorrectNativeSelect.body?.actionDispatched === false || incorrectNativeSelect.body?.inputDispatched === false,
          'The known element-type rejection must report its actual pre-input boundary; unknown transport failures stay uncertain.');
      }
      await settle(value => elements(value).some(element => element.name === deliveredProfile.location && element.role === 'option'), 'actual custom location option');
      if (!deferLocation) await act('click', deliveredProfile.location);
      if (audit) {
        const text = 'I have not independently used the optional diagram tool.';
        const written = await act('fill', 'Optional note', { text });
        const latest = written.planning?.evidenceIds?.at(-1);
        assert.ok(latest, 'The ordinary finding cites an actual returned input observation.');
        await task({ action: 'finding', finding: { ruleId: 'no-unrequested-limitation',
          message: 'The optional note volunteered an implementation limitation that was not requested.', evidenceIds: [latest] } });
        observation.ruleFinding = { text, evidenceId: latest };
      }
    }
    async function submit({ validationCode } = {}) {
      const submitted = await act('click', 'Request enrollment');
      await settle(value => validationCode
        ? records(value).some(record => record.attributes?.['data-validation-code'] === validationCode)
        : records(value).some(record => record.attributes?.['data-receipt-status'])
          || /response was interrupted|Your enrollment request has been received/.test(pageText(value)), validationCode || 'destination response');
      observeRecords();
      return submitted;
    }
    async function execute(options) {
      activeOptions = options;
      assert.equal(typeof options.onToolResultDelivered, 'function', 'The explicit host adapter must expose delivery acknowledgment for material contract results.');
      observation.operationalTurns++;
      if (mode === 'resume' && observation.operationalTurns === 2) {
        const current = await task({ action: 'read' });
        assert.equal(current.taskId, observation.cancelledTaskId, 'Supported Continue must retain the same durable task.');
        assert.ok(current.contractRuntime.unresolved.length, 'A missing external receipt must remain unsettled across cancellation.');
        await task({ action: 'focus', expectedPlanEpoch: current.contract.planEpoch, workItemId: 'enroll-participant' });
        await page({ action: 'read' });
        await settle(value => /response was interrupted/.test(pageText(value)), 'the actual interrupted response after cancellation');
        const retry = await act('click', 'Request enrollment', {}, { allowedFailure: true });
        assert.equal(retry.receipt.success, false, 'Explicit Continue must not replay the unresolved accepted effect.');
        observation.continuationReplayDenied = retry.receipt.code || retry.body?.code;
        await inspectHistory();
        assert.equal(seenConfirmed.size, configuration.count);
        observation.finalTask = await task({ action: 'read' });
        observation.review = await task({ action: 'review' });
        observation.workflowFinished = true;
        return { output: `The destination history confirms ${seenConfirmed.size} distinct new enrollments; the interrupted submission was not repeated.` };
      }
      assert.equal(observation.operationalTurns, 1, 'The deterministic provider must not hide a failed operational turn behind replay.');
      const unplanned = await task({ action: 'read' });
      assert.equal(unplanned.contract, undefined, 'The direct owner starts without automatic contract adoption.');
      const current = await task({ action: 'plan', expectedRevision: unplanned.revision, contract: copy(acceptedContract) });
      assert.equal(current.contract?.contractVersion, 2, 'The provider explicitly saves its optional contract.');
      initialEpoch = current.contract.planEpoch;
      observation.initialPlan = copy(current.contract);
      assert.equal(current.contract.criteria[0].receiptBinding, undefined, 'No receipt selector may be secretly preseeded.');
      await task({ action: 'focus', expectedPlanEpoch: initialEpoch, workItemId: 'enroll-participant' });
      if (mode === 'dependencies') await exerciseSourceDependencies();
      else await profile();
      const historyRecord = await inspectHistory();
      if (!['text-only', 'native-text'].includes(mode)) assert.ok(historyRecord, 'Ordinary prior history supplies the observed receipt grammar.');
      const links = await catalog();
      // A genuine GET form exercises renderer classification, not a direct API.
      await navigate(portal.origin + '/workshops');
      await act('fill', 'Find a workshop', { text: links[0].title });
      const search = await act('click', 'Search workshops');
      await settle(value => new URL(value.url).searchParams.get('q') === links[0].title, 'GET search navigation');
      observation.searchCallId = search.callId;
      // Same tool/action against another real destination is outside the plan.
      const foreignAttempt = await page({ action: 'navigate', url: foreign.origin + '/workshops' }, { allowedFailure: true });
      assert.equal(foreignAttempt.receipt.success, false, 'A same-action foreign resource must not borrow the portal lease.');
      observation.foreignDenied = foreignAttempt.receipt.code || foreignAttempt.body?.code;
      for (const link of links) {
        if (seenConfirmed.size >= configuration.count) break;
        await navigate(link.url);
        const canonicalId = pageText(snapshot).match(/Workshop reference:\s*(workshop-[a-f0-9]+)/)?.[1];
        assert.ok(canonicalId, 'Canonical identity must be read from the actual form, including aliases.');
        if (priorIds.has(canonicalId) || knownCanonical.has(canonicalId)) continue;
        knownCanonical.add(canonicalId);
        const form = forms(snapshot).find(value => value.fields.some(field => field.name === 'participantId'));
        assert.ok(form, 'The real browser snapshot must expose ordinary form action and control names.');
        if (!boundEpoch && !['recovery', 'text-only', 'native-text'].includes(mode)) await bind(historyRecord, form);
        const sequentialValidation = mode === 'recovery' && knownCanonical.size === 1;
        await fillProfile({ audit: mode === 'audit' && knownCanonical.size === 1, deferLocation: sequentialValidation });
        const firstSubmission = await submit(sequentialValidation ? { validationCode: 'LOCATION_SELECTION_REQUIRED' } : {});
        if (mode === 'native-text') {
          const status = records(snapshot).find(record => /Your enrollment request has been received\./.test(record.text || ''));
          assert.ok(status, 'The native response must be observed before its text can be bound.');
          assert.ok(Object.keys(status.attributes || {}).every(key => !key.startsWith('data-')), 'The native-text case cannot borrow ideal receipt attributes.');
          await bindNativeText(status, form);
          await page({ action: 'read' });
          const verified = await task({ action: 'read' });
          assert.equal(verified.contractRuntime.outcomes.filter(item => item.isNew).length, 1,
            'A later actual observation must correlate the retained native POST with this exact status before counting it.');
          seenConfirmed.add(canonicalId);
          break;
        }
        let rejected = records(snapshot).find(record => record.attributes?.['data-receipt-status'] === 'validation-rejected');
        if (rejected) {
          assert.equal(mode, 'recovery');
          if (!boundEpoch) await bind(historyRecord, form, rejected);
          // Re-observe after the material verification refinement. The adapter
          // must tie this actual absence to the earlier dispatched attempt.
          await page({ action: 'read' });
          const firstState = await task({ action: 'read' });
          // Controller assertions inspect complete host proof. These snapshots
          // never enter a tool receipt or provider input; the next form action
          // still follows only the actual public field diagnosis.
          const firstJournal = await readContractJournal(tasks, engine.listRuns()[0].taskId);
          const firstOperation = firstJournal.records.find(item => item.operationId === firstSubmission.planning?.operationId);
          assert.equal(firstOperation?.effectState, 'absent', 'The observed first rejection must reconcile its actual admitted submission.');
          const firstProofs = firstJournal.evidence.filter(item => item.kind === 'external-confirmation'
            && item.confirmation?.status === 'absent' && item.confirmation.effectKey === firstOperation.commit.effectKey);
          assert.ok(firstProofs.length, 'The first absence must have retained host proof.');
          observation.validationRecovery = { firstOperation: copy(firstOperation), firstProofs: copy(firstProofs), firstRecord: copy(rejected) };
          // A real changed payload obtains a second fresh rejection. Its bound
          // status/outcome/identity are unchanged; its visible field diagnosis
          // is new. Re-reading that response must resolve the second effect.
          await act('click', 'Location');
          await settle(value => elements(value).some(element => element.name === deliveredProfile.location && element.role === 'option'), 'actual location option after rejection');
          await act('click', deliveredProfile.location);
          const secondSubmission = await submit({ validationCode: 'CONTACT_PREFERENCE_REQUIRED' });
          await page({ action: 'read' });
          const secondState = await task({ action: 'read' });
          const secondJournal = await readContractJournal(tasks, engine.listRuns()[0].taskId);
          const secondOperation = secondJournal.records.find(item => item.operationId === secondSubmission.planning?.operationId);
          const secondRecord = records(snapshot).find(record => record.attributes?.['data-validation-code'] === 'CONTACT_PREFERENCE_REQUIRED');
          const secondProofs = secondJournal.evidence.filter(item => item.kind === 'external-confirmation'
            && item.confirmation?.status === 'absent' && item.confirmation.effectKey === secondOperation?.commit?.effectKey);
          Object.assign(observation.validationRecovery, { secondOperation: copy(secondOperation), secondProofs: copy(secondProofs),
            secondRecord: copy(secondRecord), secondRuntime: copy(secondState.contractRuntime) });
          assert.notEqual(secondOperation?.operationId, firstOperation.operationId);
          assert.notEqual(secondOperation?.commit?.effectKey, firstOperation.commit.effectKey, 'A real location selection changes the submitted payload and effect key.');
          const selectedReceiptFields = record => Object.fromEntries(Object.entries(record.attributes).filter(([key]) => key !== 'data-validation-code'));
          assert.deepEqual(selectedReceiptFields(secondRecord), selectedReceiptFields(rejected), 'Only the fresh visible validation diagnosis differs, not the selected receipt identity or status.');
          for (const proof of firstProofs) assert.deepEqual(secondJournal.evidence.find(item => item.id === proof.id), proof,
            'A fresh rejection must not rewrite earlier proof bytes.');
          assert.equal(secondOperation?.effectState, 'absent', 'The fresh CONTACT rejection must reconcile its own second effect, not be aliased to the first LOCATION effect.');
          assert.ok(secondProofs.length, 'The second absence must cite its own actual response proof.');
          assert.equal(secondState.contractRuntime.unresolved.some(item => item.operationId === secondOperation.operationId), false);
          const unchanged = await act('click', 'Request enrollment', {}, { allowedFailure: true });
          assert.equal(unchanged.receipt.success, true, 'The declared two-attempt no-progress policy permits its single bounded unchanged retry.');
          const repeated = await act('click', 'Request enrollment', {}, { allowedFailure: true });
          assert.equal(repeated.receipt.success, false, 'After two unchanged validation attempts, a third must be blocked before dispatch.');
          observation.rejectedReplay = repeated.receipt.code || repeated.body?.code;
          await act('click', 'Email confirmations only');
          await submit();
        }
        if (/response was interrupted/.test(pageText(snapshot))) {
          const retry = await act('click', 'Request enrollment', {}, { allowedFailure: true });
          assert.equal(retry.receipt.success, false, 'A lost response must not permit automatic resubmission.');
          observation.uncertainReplay = retry.receipt.code || retry.body?.code;
          await inspectHistory();
        }
        if (mode === 'text-only') break;
      }
      const final = await task({ action: 'read' });
      observation.finalTask = final;
      const review = await task({ action: 'review' });
      observation.review = review;
      observation.workflowFinished = true;
      if (mode === 'text-only') return { output: 'The destination displayed that the request was received, but no supported independent confirmation binding established a confirmed enrollment.' };
      assert.equal(seenConfirmed.size, configuration.count, 'The provider itself must see real distinct destination confirmations.');
      if (mode === 'final-failure') {
        observation.rawWorkerClaim = 'The entire task is fully complete and all verification passed.';
        throw Object.assign(new Error('Synthetic owner transport failure after verified operations.'), { code: 'FIXTURE_OWNER_FAILURE' });
      }
      return { output: `The destination confirmed ${seenConfirmed.size} distinct new enrollments.` };
    }

    async function explicitHostOptions(options) {
      const run = engine.listRuns().find(item => item.status === 'running');
      assert.ok(run?.taskId, 'The real owner run must exist before fixture adapters are attached.');
      const identity = { taskId: run.taskId, runId: run.id, nodeId: 'agent' };
      const workspace = createWorkspaceToolHandler({ cwd, signal: options.signal, ...identity });
      const browserHandler = createBrowserToolHandler({ browser, signal: options.signal, owner: identity });
      const handler = createTaskToolHandler({ store: tasks, ...identity, task: request(), cwd,
        schemaVersion: 14, planningMode: 'on', executionGuardrails: true, signal: options.signal });
      const guard = await createPlanningWorkerGuard({ store: tasks, ...identity, cwd, schemaVersion: 14,
        executionGuardrails: true, coordinator: true, signal: options.signal,
        getOperationAdapter: call => call.name === 'relay_workspace' ? workspace : browserHandler });
      const invoke = wrapPlanningToolHandler(guard, async (call, context = {}) => {
        const denied = await guard.before(call, context); if (denied) return denied;
        context = guard.dispatchContext(call, context); await guard.dispatchFallback(call, context);
        if (call.name === 'relay_task') return guard.after(call, await handler(call, context));
        return call.name === 'relay_workspace' ? workspace(call, context) : browserHandler(call, context);
      });
      return { ...options, onToolCall: call => invoke(call, { signal: options.signal }),
        onToolResultDelivered: value => guard.observeToolDelivery(value), guard };
    }
    class Runtime extends EventEmitter {
      status() { return { connected: true, authenticated: true, defaultModel: 'fixture-contract-provider', models: [{ id: 'fixture-contract-provider', supportsTools: true }] }; }
      async runAgent(options) {
        assert.notEqual(options.responseOnly, true, 'Automatic analytical providers are retired.');
        const explicit = await explicitHostOptions(options);
        try {
          return { ...(await execute(explicit)), threadId: 'synthetic-worker-' + mode,
            usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } };
        } finally { await explicit.guard.finish(options.signal.aborted ? 'cancelled' : 'finished'); }
      }
      async close() {}
    }
    const runtime = new Runtime();
    engine = await new HarnessEngine({ runtime, tasks, browser, dataDir: directory, defaultCwd: cwd }).init();
    engine.runtimeSettings = { get: () => settings };
    runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: cwd, getSettings: () => settings });
    viability = new TaskViability({ store, runner, engine, identity: { read: async () => ({ content: 'The user authorized this local synthetic enrollment exercise.' }) }, getSettings: () => settings });
    service = new ResponseCycleService({ store, runner, taskViability: viability, engine, getSettings: () => settings });
    engine.responseCycle = service;
    const workflow = createMissionWorkflow({ id: 'workshop-acceptance-' + mode, task: request(), model: 'fixture-contract-provider', cwd, planningMode: 'forced' });
    const started = engine.startRun({ workflow, input: request(), planningMode: 'forced', planningExecutionMode: 'automatic', requestId: 'workshop-acceptance-' + mode });
    runId = started.id;
    observation.originalInput = engine.getRun(runId).input;
    if (mode === 'resume') {
      await bounded(commitAccepted.promise, 'The actual server never accepted the effect before cancellation.', 45000);
      const cancelled = engine.cancelRun(runId);
      observation.cancelledTaskId = cancelled.taskId;
      observation.cancelledRunId = runId;
      commitRelease.resolve();
      await bounded(engine.executions.get(runId), 'The cancelled engine run did not settle.', 15000);
      const firstRun = engine.getRun(runId);
      assert.equal(firstRun.status, 'cancelled');
      const firstState = await tasks.get(firstRun.taskId);
      const firstJournal = await readContractJournal(tasks, firstRun.taskId);
      const firstView = contractRuntimeView(firstState, firstJournal);
      assert.equal(portal.oracle().newEffects.length, 1);
      assert.equal(firstView.outcomes.filter(item => item.isNew).length, 0);
      assert.ok(firstView.unresolved.length);
      observation.cancelledEvidence = { runId: firstRun.id, taskId: firstRun.taskId, status: firstRun.status,
        newOutcomeCount: 0, unresolved: copy(firstView.unresolved), journalSeq: firstJournal.journalSeq };
      const continued = engine.continueRun(firstRun.id, { nodeId: 'agent', message: 'Continue the original enrollment task from its saved state.',
        planningMode: 'forced', requestId: 'workshop-explicit-continue-' + mode });
      runId = continued.id;
      observation.continuedRunId = runId;
      assert.notEqual(runId, firstRun.id);
    }
    await engine.executions.get(runId);
    const run = engine.getRun(runId);
    assert.ok(observation.operationalTurns, 'Direct operational owner did not dispatch: ' + run.errorCode + ': ' + run.error);
    const state = await tasks.get(run.taskId);
    const journal = await readContractJournal(tasks, run.taskId);
    const view = contractRuntimeView(state, journal);
    const durableOperations = journal.records;
    assert.ok(Array.isArray(durableOperations), 'The proof check must use the complete durable operation journal.');
    observation.searchOperation = copy(durableOperations.find(item => item.callId === observation.searchCallId));
    const oracle = portal.oracle();
    report.run = { id: run.id, status: run.status, error: run.error, input: run.input, output: run.output,
      agentOutput: run.nodes?.agent?.output, planningEnforcement: run.planningEnforcement };
    report.observation = observation;
    report.contractRuntime = view;
    if (mode === 'recovery') report.contractJournal = copy(journal);
    report.oracle = oracle;
    report.foreignOracle = foreign.oracle();
    report.hiddenWindowCount = BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
    check('the provider reaches its actual post-work review', () => assert.equal(observation.workflowFinished, true, run.error));
    check('ordinary user request is unchanged', () => assert.equal(observation.originalInput, request()));
    if (mode !== 'audit') check('ordinary acceptance contains no anti-bug instruction', () => {
      assert.equal(observation.originalInput, requestFor(portal.origin, configuration.count));
      assert.deepEqual(observation.initialPlan.instructions, []);
      assert.deepEqual(deliveredProfile.preferences, []);
    });
    check('legacy Forced input does not start an automatic cycle', () => {
      assert.equal(run.responseCycle, undefined);
      assert.deepEqual(report.stages, []);
      assert.equal(report.normalizerChecks, 0);
    });
    check('one canonical contract reaches the operational worker', () => assert.equal(observation.initialPlan?.contractVersion, 2));
    check('no live profile or visible window is used', () => assert.equal(report.hiddenWindowCount, 0));
    check('same-action foreign target never reaches the destination', () => assert.equal(report.foreignOracle.requests.length, 0));
    check('a real GET form submission stays a navigation interaction', () => assert.equal(observation.searchOperation?.effect, 'interact'));
    const structural = report.calls.filter(call => call.name === 'relay_task' && ['plan', 'edit', 'step'].includes(call.action));
    check('field interactions do not rewrite the plan', () => assert.equal(structural.length, mode === 'text-only' ? 1 : 2));
    if (mode === 'text-only') {
      check('plain text cannot manufacture a confirmed count', () => assert.equal(view.outcomes.filter(item => item.isNew).length, 0));
      check('the independent oracle still records the actual accepted effect', () => assert.equal(oracle.newEffects.length, 1));
      check('truthful unknown work returns without a compulsory finalizer', () => {
        assert.equal(run.status, 'completed');
        assert.equal(observation.review.contractRuntime.review.complete, false);
        assert.match(run.output, /no supported independent confirmation/);
      });
    } else {
      if (mode !== 'final-failure') check('the direct owner completes after its explicit verification', () => assert.equal(run.status, 'completed', run.error));
      check('exact distinct host outcomes agree with the private destination oracle', () => {
        assert.equal(view.outcomes.filter(item => item.isNew).length, configuration.count);
        assert.equal(oracle.newUniqueCanonicalIds.length, configuration.count);
        assert.equal(oracle.newEffects.length, configuration.count, 'An alias or retry must never create another effect.');
        const actualDestinations = view.outcomes.filter(item => item.isNew).map(outcome => {
          const bound = [...new Set(journal.records.filter(record => record.commit?.effectKey === outcome.effectKey)
            .map(record => record.commit.destinationKey))];
          assert.equal(bound.length, 1, 'Each confirmed outcome retains one actual admitted destination binding.');
          return bound[0];
        });
        assert.deepEqual(actualDestinations.sort(), oracle.newEffects.map(item => 'destination:' + item.formAction).sort(),
          'Exact host outcome destinations must equal the independent server effects, not merely match their count.');
        assert.ok(oracle.newEffects.every(item => item.fields.firstName === deliveredProfile.firstName), 'A repeated same-field correction must reach the actual committed payload.');
      });
      check('prior records are preserved and excluded from the new count', () => assert.equal(oracle.records.filter(item => item.prior).length, mode === 'native-text' ? 0 : 2));
      check('only substantive verification discovery changes the epoch', () => assert.equal(state.contract.planEpoch, initialEpoch + 1));
      const afterBinding = observation.callEpochs.filter(item => item.epoch === boundEpoch && item.name !== 'relay_task');
      check('cohesive input uses the same material plan epoch', () => assert.ok(afterBinding.length >= (mode === 'native-text' ? 1 : 7)));
      if (mode === 'recovery') {
        check('two fresh field rejections remain distinct while unchanged retries do not submit again', () => {
          const rejections = oracle.requests.filter(item => item.kind === 'validation-returned');
          assert.deepEqual(rejections.map(item => item.validation.code), ['LOCATION_SELECTION_REQUIRED', 'CONTACT_PREFERENCE_REQUIRED']);
          assert.equal(new Set(rejections.map(item => item.payloadDigest)).size, 2);
          const posts = oracle.requests.filter(item => item.kind === 'commit-request');
          assert.equal(posts.length, configuration.count + 2, 'Exactly two rejected and four accepted requests reach the real server.');
          assert.equal(new Set(posts.map(item => item.clientSubmissionId)).size, posts.length, 'Each POST comes from one distinct real form submit event.');
          for (const item of [observation.validationRecovery.firstOperation, observation.validationRecovery.secondOperation]) {
            const retained = journal.records.find(record => record.operationId === item.operationId);
            assert.equal(retained.effectState, 'absent');
            assert.deepEqual(retained.commit, item.commit, 'Later responses preserve each admitted operation identity.');
          }
          for (const proof of [...observation.validationRecovery.firstProofs, ...observation.validationRecovery.secondProofs]) {
            assert.deepEqual(journal.evidence.find(item => item.id === proof.id), proof, 'The complete durable journal preserves earlier proof bytes.');
          }
        });
        check('lost response is reconciled without a replayed effect', () => assert.equal(oracle.requests.filter(item => item.kind === 'response-lost').length, 1));
      }
      if (mode === 'audit') {
        check('audit-only violation is reported without changing the submitted text', () => {
          assert.ok(observation.ruleFinding);
          assert.ok(oracle.newEffects.some(item => item.fields.notes === observation.ruleFinding.text));
          assert.ok(view.findings.some(item => item.ruleId === 'no-unrequested-limitation'));
        });
      }
      if (mode === 'native-text') check('ordinary text is correlated with an actual native URL-encoded POST', () => {
        assert.equal(oracle.requests.filter(item => item.kind === 'commit-request').length, 1);
        assert.match(oracle.requests.find(item => item.kind === 'commit-request').contentType, /^application\/x-www-form-urlencoded/);
      });
      if (mode === 'final-failure') check('failed owner retains real receipt proof without publishing an unreturned claim', () => {
        assert.equal(run.status, 'failed');
        assert.equal(run.errorCode, 'FIXTURE_OWNER_FAILURE');
        assert.ok(!String(run.output || '').includes(observation.rawWorkerClaim));
        assert.equal(view.outcomes.filter(item => item.isNew).length, 1);
        assert.equal(observation.review.contractRuntime.review.complete, true);
      });
      if (mode === 'dependencies') check('parallel observations and source prerequisites retain their actual evidence', () => {
        assert.equal(observation.parallelObservation.browserPendingAtSourceReturn, true);
        assert.equal(observation.sourceCoverage.versionMixRejected, true);
        assert.ok(observation.dependencyDenied);
        assert.equal(oracle.requests.filter(item => item.kind === 'commit-request').length, 1);
        assert.equal(oracle.newEffects[0].fields.phone, '+1 202 555 0102');
        assert.equal(view.criteria.find(item => item.id === 'current-profile').satisfied, true);
      });
      if (mode === 'resume') check('supported Continue reconciles one cancelled uncertain effect without replay', () => {
        assert.equal(observation.operationalTurns, 2);
        assert.equal(run.taskId, observation.cancelledTaskId);
        assert.equal(observation.cancelledEvidence.status, 'cancelled');
        assert.ok(observation.continuationReplayDenied);
        assert.equal(oracle.requests.filter(item => item.kind === 'commit-request').length, 1);
        assert.equal(oracle.requests.filter(item => item.kind === 'response-lost').length, 1);
        assert.equal(view.unresolved.length, 0);
      });
    }
    report.ok = true;
    return report;
  } catch (error) {
    report.ok = false; report.error = error.stack || String(error);
    report.observation = observation;
    if (runId && engine) report.run = engine.getRun(runId);
    if (portal) report.oracle = portal.oracle();
    if (foreign) report.foreignOracle = foreign.oracle();
    throw Object.assign(error, { report });
  } finally {
    parallelRelease.resolve();
    commitRelease.resolve();
    const cleanupErrors = [];
    for (const [name, resource] of [['engine', engine], ['runner', runner], ['service', service], ['viability', viability],
      ['planning store', store], ['task store', tasks], ['browser', browser], ...(!browser ? [['driver', driver]] : []),
      ['portal', portal], ['foreign portal', foreign]]) {
      try { await resource?.close(); }
      catch (error) { cleanupErrors.push({ name, error: error.stack || String(error) }); }
    }
    if (cleanupErrors.length) {
      report.cleanupErrors = cleanupErrors;
      if (report.ok) { report.ok = false; report.error = 'Isolated fixture cleanup failed.'; throw Object.assign(new Error(report.error), { report }); }
    }
  }
}

if (childMode) {
  const { app } = await import('electron');
  const value = key => process.argv.find(argument => argument.startsWith('--' + key + '='))?.slice(key.length + 3);
  const directory = value('fixture-data'), mode = value('fixture-mode');
  if (!directory || !path.isAbsolute(directory) || !path.basename(directory).startsWith('blackice-workflow-')) throw new Error('An isolated disposable directory is required.');
  app.setPath('userData', path.join(directory, 'electron-profile'));
  app.on('window-all-closed', () => {});
  // Electron emits ready after evaluating its main module. Awaiting it at the
  // module's top level would delay the event that could resolve that await.
  app.whenReady().then(async () => {
    let report;
    try { report = await runElectronCase({ directory, mode }); }
    catch (error) { report = error.report || { ok: false, error: error.stack || String(error) }; }
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }).catch(async error => {
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error) }));
    app.exit(1);
  });
} else {
  const { default: test } = await import('node:test');
  for (const configuration of cases) test(configuration.label, {
    skip: process.platform !== 'win32' && 'The required Windows gate runs this isolated real Electron fixture.',
    timeout: configuration.count === 20 ? 300000 : 180000,
  }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'blackice-workflow-' + configuration.id + '-'));
    let child;
    t.after(async () => { if (child?.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); });
    const require = createRequire(import.meta.url);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [fileURLToPath(import.meta.url), '--workshop-acceptance-child',
      '--fixture-data=' + directory, '--fixture-mode=' + configuration.id],
    { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-12000); });
    const timer = setTimeout(() => child.kill(), configuration.count === 20 ? 280000 : 160000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    let report;
    try { report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')); }
    catch (error) { assert.fail('The isolated acceptance process produced no complete receipt: ' + output + '\n' + error.message); }
    const evidenceDirectory = fileURLToPath(new URL('../.build/planning-workflow-acceptance/', import.meta.url));
    await mkdir(evidenceDirectory, { recursive: true });
    const evidencePath = path.join(evidenceDirectory, configuration.id + '-last-' + (report.ok ? 'success' : 'failure') + '.json');
    const bytes = JSON.stringify(report, null, 2);
    await writeFile(evidencePath, bytes);
    await writeFile(path.join(evidenceDirectory, configuration.id + '-' + (report.run?.id || Date.now()) + '.json'), bytes);
    if (!report.ok) t.diagnostic('Synthetic acceptance failure evidence: ' + evidencePath);
    assert.equal(code, 0, report.error || output);
    assert.equal(report.ok, true, report.error);
    assert.equal(report.onlyLoopback, true);
    assert.equal(report.liveProfileAccessed, false);
    assert.equal(report.hiddenWindowCount, 0);
    assert.ok(report.checks.includes('one canonical contract reaches the operational worker'));
  });
}
