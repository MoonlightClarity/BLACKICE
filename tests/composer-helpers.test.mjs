import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_PROMPTS, starterPrompt, welcomeReadiness, workingFolderLabel, runtimeConnectionFeedback } from '../public/composer-helpers.mjs';

test('working folder labels are readable and the full original path remains available', () => {
  assert.deepEqual(workingFolderLabel('C:\\Users\\example\\Documents\\Client Work'), {name:'Client Work',path:'C:\\Users\\example\\Documents\\Client Work',missing:false});
  assert.deepEqual(workingFolderLabel('C:\\Users\\example\\Documents\\Client Work\\'), {name:'Client Work',path:'C:\\Users\\example\\Documents\\Client Work\\',missing:false});
  assert.deepEqual(workingFolderLabel('/home/user/project/'), {name:'project',path:'/home/user/project/',missing:false});
  assert.deepEqual(workingFolderLabel('C:\\'), {name:'C:\\',path:'C:\\',missing:false});
  assert.deepEqual(workingFolderLabel('/'), {name:'/',path:'/',missing:false});
  assert.deepEqual(workingFolderLabel('  '), {name:'Choose folder',path:'',missing:true});
  assert.deepEqual(workingFolderLabel(null), {name:'Choose folder',path:'',missing:true});
});
test('quick starts insert safe, legible prompts only when explicitly chosen', () => {
  assert.equal(STARTER_PROMPTS.length,4);
  assert.deepEqual(STARTER_PROMPTS.map(item=>item.id),['review-files','research','plan','draft']);
  assert.equal(new Set(STARTER_PROMPTS.map(item=>item.id)).size,4);
  assert.ok(STARTER_PROMPTS.every(item=>item.prompt.length>40 && item.prompt.length<1000 && item.label.length<30));
  assert.match(starterPrompt('review-files'),/Do not change any files yet/);
  assert.match(starterPrompt('research'),/verified/);
  assert.match(starterPrompt('plan'),/Verify actual results/);
  assert.match(starterPrompt('draft'),/Do not publish or send anything without an explicit request/);
  assert.ok(STARTER_PROMPTS.every(item=>['teal','violet','amber','blue'].includes(item.tint) && typeof item.icon==='string'));
  assert.equal(starterPrompt('__unknown__'),null);
});

test('welcome readiness requires a loaded selected model and distinguishes connection, settings, and folder blockers', () => {
  const connected = { statusLoaded: true, streamState: 'live', model: { label: 'Chosen model', available: true }, cwd: 'C:\\Project' };
  assert.equal(welcomeReadiness().state, 'loading');
  assert.equal(welcomeReadiness({ ...connected, statusLoaded: false }).state, 'loading');
  assert.equal(welcomeReadiness({ ...connected, streamState: 'reconnecting' }).state, 'reconnecting');
  for (const model of [undefined, { label: 'Unknown model' }, { label: 'Offline model', available: false }]) {
    const result = welcomeReadiness({ ...connected, model });
    assert.equal(result.state, 'setup');
    assert.equal(result.action, 'connections');
    assert.doesNotMatch(result.title, /ready/i);
  }
  const ready = welcomeReadiness(connected);
  assert.equal(ready.state, 'ready');
  assert.match(ready.detail, /Chosen model/);
  assert.equal(welcomeReadiness({ ...connected, settingsError: 'Ultra is unavailable.' }).action, 'chat-context');
  assert.equal(welcomeReadiness({ ...connected, cwd: '  ' }).action, 'message-options');
});


test('runtime feedback follows real selected-route stages and retains distinct terminal states', () => {
  for (const phase of ['starting', 'initializing', 'reading-account-and-models']) {
    const status = { defaultModelSelection: 'native-kept', codex: { connection: { phase }, connected: false } };
    const progress = runtimeConnectionFeedback({ status }); assert.equal(progress.busy, true); assert.equal(progress.phase, phase);
    const welcome = welcomeReadiness({ statusLoaded: true, status, model: { available: false } });
    assert.equal(welcome.state, 'connecting'); assert.equal(welcome.action, null); assert.doesNotMatch(welcome.title, /offline|connect a model/i);
  }
  const failed = { defaultModelSelection: 'native-kept', codex: { connection: { phase: 'failed' }, lastError: 'Fixture handshake failed.' } };
  assert.equal(runtimeConnectionFeedback({ status: failed }).busy, false); assert.match(welcomeReadiness({ statusLoaded: true, status: failed }).detail, /Fixture handshake failed/);
  assert.equal(welcomeReadiness({ statusLoaded: true, status: failed }).action, 'connections');
  const signedOut = { codex: { connected: true, authenticated: false, connection: { phase: 'sign-in-required' } } };
  assert.match(runtimeConnectionFeedback({ status: signedOut }).title, /Sign in/); assert.equal(runtimeConnectionFeedback({ status: signedOut }).busy, false);
  assert.equal(runtimeConnectionFeedback({ status: { codex: { connection: { phase: 'ready' } } } }), null);
});

test('an API selection ignores unused Codex startup or failure without replacing the saved choice', () => {
  for (const phase of ['starting', 'initializing', 'reading-account-and-models', 'failed', 'sign-in-required']) {
    const status = { defaultModel: 'saved-api::kept', defaultModelSelection: 'saved-api::kept', codex: { connection: { phase }, lastError: 'Unused Codex failure.' } }, before = structuredClone(status);
    assert.equal(runtimeConnectionFeedback({ status }), null);
    assert.equal(welcomeReadiness({ statusLoaded: true, status, model: { available: true }, cwd: 'C:\\Fixture' }).state, 'ready');
    assert.equal(runtimeConnectionFeedback({ status, model: 'other-api::selected' }), null);
    assert.deepEqual(status, before);
    assert.ok(runtimeConnectionFeedback({ status, model: 'explicit-native' }), 'an explicitly selected native route still has its own progress');
  }
});

test('automatic default pinning and catalog refresh have honest indeterminate progress', () => {
  const selecting = { defaultModelInitializing: true, defaultModel: 'saved-api::kept' };
  assert.equal(runtimeConnectionFeedback({ status: selecting }).phase, 'choosing-model');
  assert.equal(runtimeConnectionFeedback({ status: selecting, model: 'explicit-api::kept' }), null);
  const refreshing = { codex: { connected: true, authenticated: true, connection: { phase: 'reading-account-and-models' } } };
  assert.match(runtimeConnectionFeedback({ status: refreshing }).title, /Refreshing/);
  assert.equal(welcomeReadiness({ statusLoaded: true, status: refreshing, model: { available: true } }).state, 'connecting');
});
