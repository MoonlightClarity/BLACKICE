import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceToolHandler, WORKSPACE_INSTRUCTIONS, WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';

const call = args => ({ name: 'relay_workspace', arguments: args });
const parsed = response => JSON.parse(response.contentItems[0].text);
const quote = text => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script, args = []) => `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)} ${args.map(quote).join(' ')}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitForFile = async file => {
  const end = Date.now() + 7000;
  while (Date.now() < end) { try { return JSON.parse(await readFile(file, 'utf8')); } catch {} await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Child process did not create its PID receipt.');
};
async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-workspace-test-'));
  const cwd = path.join(directory, 'project'), other = path.join(directory, 'other'); await mkdir(cwd); await mkdir(other);
  const events = [], handler = createWorkspaceToolHandler({ cwd, onEvent: event => events.push(event), ...options });
  t.after(async () => { assert.match(path.basename(directory), /^relay-workspace-test-/); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, other, events, handler };
}

test('real atomic writes, UTF-8 line reads, directory listing and absolute paths work without approval', async t => {
  const { handler, cwd, other, events } = await harness(t);
  const written = await handler(call({ action: 'write', path: 'src/example.txt', text: 'First line\nSecond ✓ line\nThird line\n' }));
  assert.equal(written.success, true); assert.equal(parsed(written).atomic, true);
  assert.equal(await readFile(path.join(cwd, 'src', 'example.txt'), 'utf8'), 'First line\nSecond ✓ line\nThird line\n');
  const read = await handler(call({ action: 'read', path: 'src/example.txt', startLine: 2, lineCount: 1 }));
  assert.equal(read.success, true); assert.equal(parsed(read).content, '2: Second ✓ line'); assert.equal(parsed(read).truncated, true);
  assert.equal((await handler(call({ action: 'write', path: path.join(other, 'outside.txt'), text: 'Explicit absolute destination.' }))).success, true);
  assert.equal(await readFile(path.join(other, 'outside.txt'), 'utf8'), 'Explicit absolute destination.');
  assert.equal((await handler(call({ action: 'write', path: 'src/example.txt', text: 'Replaced atomically.' }))).success, true);
  assert.deepEqual(await readdir(path.join(cwd, 'src')), ['example.txt']);
  const listed = parsed(await handler(call({ action: 'list', depth: 1 })));
  assert.ok(listed.entries.some(entry => entry.name === path.join('src', 'example.txt')));
  assert.ok(events.some(event => event.action === 'write'));
});

test('read refuses binary files and output limits remain valid JSON', async t => {
  const { handler, cwd } = await harness(t);
  await writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 2, 3, 4]));
  const binary = await handler(call({ action: 'read', path: 'binary.dat' })); assert.equal(binary.success, false); assert.match(parsed(binary).error, /binary/);
  await writeFile(path.join(cwd, 'large.txt'), '"'.repeat(100000));
  const large = await handler(call({ action: 'read', path: 'large.txt' }));
  assert.ok(large.contentItems[0].text.length <= 40000); assert.equal(large.success, false); assert.equal(parsed(large).code, 'WORKSPACE_READ_LINE_TOO_LONG'); assert.match(parsed(large).error, /Line 1.*run/);
  const invalid = await handler(call({ action: 'read', path: 'bad\0path' })); assert.equal(invalid.success, false); assert.match(parsed(invalid).error, /path/);
});

test('workspace tools have no hidden 200-action cutoff and retain an explicitly configured action budget', async t => {
  const { handler } = await harness(t);
  for (let index = 0; index < 205; index++) assert.equal((await handler(call({ action: 'list' }))).success, true);
  const { handler: limited } = await harness(t, { maxCalls: 2 });
  assert.equal((await limited(call({ action: 'list' }))).success, true); assert.equal((await limited(call({ action: 'list' }))).success, true);
  const stopped = await limited(call({ action: 'list' })); assert.equal(stopped.success, false); assert.match(parsed(stopped).error, /configured workspace action limit/);
});

for (const fallback of [false, true]) {
  test(`${fallback ? 'filesystem fallback' : 'ripgrep when available'} search finds actual text and skips generated/dependency directories`, async t => {
    const { handler, cwd } = await harness(t, fallback ? { rgCommand: '__relay_missing_search_executable__' } : {});
    await mkdir(path.join(cwd, 'src')); await mkdir(path.join(cwd, 'node_modules')); await mkdir(path.join(cwd, '.git'));
    await writeFile(path.join(cwd, 'src', 'index.txt'), 'No match\nAn Actual Needle lives here.\nAnother line.\n');
    await writeFile(path.join(cwd, 'node_modules', 'dependency.txt'), 'Actual Needle must be excluded.');
    await writeFile(path.join(cwd, '.git', 'internal.txt'), 'Actual Needle must be excluded.');
    const searched = await handler(call({ action: 'search', query: 'actual needle' })); assert.equal(searched.success, true);
    const found = parsed(searched); if (fallback) assert.equal(found.engine, 'filesystem');
    const text = JSON.stringify(found); assert.match(text, /Actual Needle lives here/); assert.doesNotMatch(text, /must be excluded/);
    const sensitive = parsed(await handler(call({ action: 'search', query: 'ACTUAL NEEDLE', caseSensitive: true })));
    assert.ok(sensitive.engine === 'rg' ? !sensitive.output : sensitive.matches.length === 0);
  });

  test(`${fallback ? 'filesystem fallback' : 'ripgrep when available'} reports pipe queries as one literal instead of independent term searches`, async t => {
    const { handler, cwd } = await harness(t, fallback ? { rgCommand: '__relay_missing_search_executable__' } : {});
    const file = path.join(cwd, 'application-history.txt'), query = 'YipitData|6397670';
    await writeFile(file, 'Prior application: YipitData\nPosting ID: 6397670\n');
    const absent = parsed(await handler(call({ action: 'search', query })));
    assert.equal(absent.matchMode, 'literal'); assert.equal(absent.query, query);
    assert.equal(absent.path, cwd); assert.equal(absent.truncated, false);
    assert.ok(absent.engine === 'rg' ? absent.output === '' : absent.matches.length === 0);
    assert.match(absent.note, /exact literal.*reported search coverage/i);
    assert.match(absent.note, /separate/i);
    if (fallback) assert.equal(absent.engine, 'filesystem');
    t.diagnostic(`Search engine exercised: ${absent.engine}`);
    for (const term of ['YipitData', '6397670']) {
      const found = parsed(await handler(call({ action: 'search', query: term })));
      assert.equal(found.matchMode, 'literal'); assert.equal(found.query, term);
      assert.ok(found.engine === 'rg' ? found.output.includes(term) : found.matches.some(item => item.text.includes(term)));
      assert.equal(found.note, undefined);
    }
    await writeFile(file, 'A literal marker: YipitData|6397670\n');
    const exact = parsed(await handler(call({ action: 'search', query })));
    assert.equal(exact.matchMode, 'literal'); assert.equal(exact.query, query);
    assert.ok(exact.engine === 'rg' ? exact.output.includes(query) : exact.matches.some(item => item.text.includes(query)));
    assert.equal(exact.note, undefined, 'The exact pipe text remains searchable without query rewriting.');
  });
}

test('real shell runs return their working directory, stderr and actual nonzero exit code', async t => {
  const { handler, cwd, other } = await harness(t);
  const command = process.platform === 'win32' ? "Write-Output (Get-Location).Path;[Console]::Error.WriteLine('intentional stderr');exit 7" : "pwd; printf 'intentional stderr\\n' >&2; exit 7";
  const response = await handler(call({ action: 'run', command, cwd: other }));
  assert.equal(response.success, false); const ran = parsed(response);
  assert.equal(ran.exitCode, 7); assert.equal(ran.cwd, other); assert.match(ran.stderr, /intentional stderr/);
  assert.ok(ran.stdout.toLowerCase().includes(other.toLowerCase())); assert.equal(ran.timedOut, false);
  const success = await handler(call({ action: 'run', command: process.platform === 'win32' ? "Write-Output 'verified-shell-result'" : "printf 'verified-shell-result\\n'" }));
  assert.equal(success.success, true); assert.equal(parsed(success).exitCode, 0); assert.match(parsed(success).stdout, /verified-shell-result/);
});

test('bounded filesystem search previews retain literal mode and the exact query', async t => {
  const { handler, cwd, events } = await harness(t, { rgCommand: '__relay_missing_search_executable__', captureSearchCoverage: true });
  const query = 'audit|marker';
  await writeFile(path.join(cwd, 'many.txt'), (query + ' ' + 'x'.repeat(480) + '\n').repeat(100));
  const response = await handler(call({ action: 'search', query, limit: 100 })), found = parsed(response);
  assert.equal(response.success, true); assert.ok(response.contentItems[0].text.length <= 40000);
  assert.equal(found.matchMode, 'literal'); assert.equal(found.query, query); assert.equal(found.engine, 'filesystem');
  assert.equal(found.truncated, true); assert.ok(found.preview);
  const baseline = createWorkspaceToolHandler({cwd,rgCommand:'__relay_missing_search_executable__'});
  assert.deepEqual(response,await baseline(call({action:'search',query,limit:100})));
  const coverage=events.find(e=>e.type==='workspace.search.coverage');
  assert.equal(coverage.resultPreviewOnly,true);
  assert.equal(coverage.truncated,true);
  assert.equal(coverage.returnedMatches,undefined);
});

test('only an executor-supplied origin reaches the command child and inherited case variants are stripped', async t => {
  const key = 'BLACKICE_RESTART_ORIGIN', alternate = 'blackice_restart_origin';
  const before = { [key]: process.env[key], [alternate]: process.env[alternate] };
  try {
    process.env[key] = 'ambient-stale-origin'; process.env[alternate] = 'ambient-case-variant';
    const token = 'b'.repeat(64), normal = await harness(t), owned = await harness(t, { restartOriginToken: token });
    const script = path.join(normal.cwd, 'origin-child.mjs');
    await writeFile(script, `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() === '${key}'))));`);
    const command = nodeCommand(script);
    const plain = parsed(await normal.handler(call({ action: 'run', command })));
    const bound = parsed(await owned.handler(call({ action: 'run', command })));
    assert.deepEqual(JSON.parse(plain.stdout), {});
    assert.deepEqual(JSON.parse(bound.stdout), { [key]: token });
    assert.equal(process.env[key], process.platform === 'win32' ? 'ambient-case-variant' : 'ambient-stale-origin');
  } finally {
    for (const name of [alternate, key]) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
  }
});

test('shell output is drained and capped while the actual exit code is preserved', async t => {
  const { handler, cwd } = await harness(t);
  const script = path.join(cwd, 'large-output.cjs'); await writeFile(script, 'process.stdout.write("\\\"".repeat(100000));');
  const response = await handler(call({ action: 'run', command: nodeCommand(script) }));
  assert.equal(response.success, true); assert.ok(response.contentItems[0].text.length <= 40000);
  const output = parsed(response); assert.equal(output.exitCode, 0); assert.equal(output.truncated, true);
});

async function processTreeFixture(t) {
  const value = await harness(t), script = path.join(value.cwd, 'process-tree.cjs'), pidFile = path.join(value.cwd, 'pids.json');
  await writeFile(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  let pids;
  t.after(() => { if (pids) for (const pid of Object.values(pids)) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  return { ...value, script, pidFile, receipt: async () => (pids = await waitForFile(pidFile)) };
}
test('external cancellation terminates a real shell and its child process tree before rejecting', async t => {
  const { handler, script, pidFile, receipt } = await processTreeFixture(t), controller = new AbortController();
  const pending = handler(call({ action: 'run', command: nodeCommand(script, [pidFile]), timeoutMs: 15000 }), { signal: controller.signal });
  const pids = await receipt(); assert.equal(alive(pids.parent), true); assert.equal(alive(pids.child), true);
  controller.abort(); await assert.rejects(pending, cause => cause.name === 'AbortError');
  assert.equal(alive(pids.parent), false, 'command process must be terminated'); assert.equal(alive(pids.child), false, 'descendant must be terminated');
});
test('command timeout reports failure and cleans up the actual process tree', async t => {
  const { handler, script, pidFile, receipt } = await processTreeFixture(t);
  const pending = handler(call({ action: 'run', command: nodeCommand(script, [pidFile]), timeoutMs: 2500 }));
  const pids = await receipt(), response = await pending;
  assert.equal(response.success, false); assert.equal(parsed(response).timedOut, true);
  assert.equal(alive(pids.parent), false); assert.equal(alive(pids.child), false);
});

test('queued/cancelled calls do not write and application guidance describes available adapters', async t => {
  const { handler, cwd } = await harness(t), controller = new AbortController(); controller.abort();
  await assert.rejects(handler(call({ action: 'write', path: 'must-not-exist.txt', text: 'No write.' }), { signal: controller.signal }), cause => cause.name === 'AbortError');
  assert.deepEqual(await readdir(cwd), []);
  assert.equal(WORKSPACE_TOOL.name, 'relay_workspace');
  // Retire repeated global policy; keep actual adapter routing and cancellation checks.
  assert.ok(WORKSPACE_TOOL.inputSchema.properties.action.enum.includes('run'));
  assert.match(WORKSPACE_INSTRUCTIONS, /Application automation[^.]*attached adapter's schema/);
  assert.doesNotMatch(WORKSPACE_INSTRUCTIONS, /relay_desktop|do not operate existing user windows/);
  const routing = capabilityGuidance([WORKSPACE_TOOL, {name:'relay_browser'}]);
  assert.match(routing, /relay_browser/);
});

async function completeReadPages(handler, selected, expected) {
  const rebuilt = []; let startLine = 1, pages = 0;
  while (true) {
    const response = await handler(call({ action: 'read', path: selected, startLine, lineCount: 1500 }));
    assert.equal(response.success, true); assert.ok(response.contentItems[0].text.length <= 40000);
    const page = parsed(response); assert.equal(typeof page.content, 'string', 'read metadata must survive output budgeting');
    const rows = page.content.split('\n').map((row, index) => {
      const prefix = `${startLine + index}: `;
      assert.ok(row.startsWith(prefix)); return row.slice(prefix.length);
    });
    assert.deepEqual(rows, expected.slice(startLine - 1, startLine - 1 + rows.length), 'a page must contain whole, exact source lines');
    assert.equal(page.endLine, startLine + rows.length - 1); rebuilt.push(...rows); pages++;
    if (page.nextStartLine === null) { assert.equal(page.truncated, false); break; }
    assert.equal(page.truncated, true); assert.equal(page.nextStartLine, page.endLine + 1);
    assert.ok(page.nextStartLine > startLine && pages <= expected.length); startLine = page.nextStartLine;
  }
  assert.deepEqual(rebuilt, expected, 'following only the returned cursor must recover every line exactly once');
  return pages;
}

test('bounded reads return complete lines and a lossless continuation after the text cap', async t => {
  const { handler, cwd } = await harness(t);
  const lines = Array.from({ length: 701 }, (_, index) => index % 19 === 0 ? '' : `row-${index + 1} ${'text ✓ 😀 '.repeat(14)}`);
  await writeFile(path.join(cwd, 'many-lines.txt'), lines.join('\r\n'));
  assert.ok(await completeReadPages(handler, 'many-lines.txt', lines) > 1);
});

test('bounded reads preserve pagination when JSON escaping expands the returned text', async t => {
  const { handler, cwd } = await harness(t);
  const lines = Array.from({ length: 401 }, (_, index) => `row-${index + 1} ${'"\\\t'.repeat(75)}`);
  await writeFile(path.join(cwd, 'escaped-lines.txt'), lines.join('\n'));
  assert.ok(await completeReadPages(handler, 'escaped-lines.txt', lines) > 1);
});

test('an oversized line is reported explicitly without claiming later lines were read', async t => {
  const { handler, cwd } = await harness(t);
  await writeFile(path.join(cwd, 'wide-line.txt'), 'before\n' + '\\'.repeat(21000) + '\nafter');
  const first = parsed(await handler(call({ action: 'read', path: 'wide-line.txt' })));
  assert.equal(first.content, '1: before'); assert.equal(first.endLine, 1); assert.equal(first.nextStartLine, 2);
  const oversized = await handler(call({ action: 'read', path: 'wide-line.txt', startLine: first.nextStartLine }));
  assert.equal(oversized.success, false); assert.equal(parsed(oversized).code, 'WORKSPACE_READ_LINE_TOO_LONG'); assert.match(parsed(oversized).error, /Line 2.*run/);
  const after = parsed(await handler(call({ action: 'read', path: 'wide-line.txt', startLine: 3 })));
  assert.equal(after.content, '3: after'); assert.equal(after.endLine, 3); assert.equal(after.nextStartLine, null); assert.equal(after.truncated, false);
});

test('the one MiB preview excludes its unfinished line and never promises an unreachable continuation', async t => {
  const { handler, cwd } = await harness(t);
  const fixtures = [
    { name: 'partial-tail.txt', text: '123456789\n'.repeat(80000) + 'z'.repeat(300000) + '\nlast', start: 79998, last: 80000, line: '123456789' },
    { name: 'newline-boundary.txt', text: ('a'.repeat(511) + '\n').repeat(2048) + 'later', start: 2048, last: 2048, line: 'a'.repeat(511) },
  ];
  for (const fixture of fixtures) {
    await writeFile(path.join(cwd, fixture.name), fixture.text);
    const response = await handler(call({ action: 'read', path: fixture.name, startLine: fixture.start, lineCount: 20 }));
    assert.equal(response.success, true); const page = parsed(response);
    assert.equal(page.content, Array.from({ length: fixture.last - fixture.start + 1 }, (_, index) => `${fixture.start + index}: ${fixture.line}`).join('\n'));
    assert.equal(page.endLine, fixture.last); assert.equal(page.nextStartLine, null); assert.equal(page.truncated, true); assert.equal(page.totalLines, undefined); assert.match(page.note, /first 1 MiB.*run/);
    const beyond = await handler(call({ action: 'read', path: fixture.name, startLine: fixture.last + 1 }));
    assert.equal(beyond.success, false); assert.equal(parsed(beyond).code, 'WORKSPACE_READ_PREVIEW_LIMIT'); assert.match(parsed(beyond).error, /run/);
  }
});


for (const explicitPath of [false, true]) test(`oversized ${explicitPath ? 'explicit-path' : 'default'} listings stay bounded without retired policy and support filename continuation`, async t => {
  let policyCalls = 0;
  const { handler, cwd } = await harness(t, { getTaskPolicy: () => { policyCalls++; throw Error('Retired policy callback must not run'); } });
  await Promise.all(Array.from({ length: 150 }, (_, i) => writeFile(path.join(cwd, String(i).padStart(3, '0') + '-'.repeat(180) + '.txt'), '')));
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await handler(call({ action: 'list', ...(explicitPath ? { path: '.' } : {}) }));
    assert.equal(response.success, true);
    assert.ok(response.contentItems[0].text.length <= 40000);
    const value = parsed(response);
    assert.equal(value.activeTaskPolicy, undefined);
    assert.equal(value.truncated, true);
    assert.ok(value.preview, 'oversized listing must disclose truncation rather than claim complete enumeration');
    assert.match(value.message, /output limit.*Narrow/i);
  }
  const matches = [];
  let args = { action: 'find', path: '.', query: '.txt', limit: 17, timeoutMs: 10000 }, pages = 0;
  for (;;) {
    const response = await handler(call(args));
    assert.equal(response.success, true);
    assert.ok(response.contentItems[0].text.length <= 40000);
    const value = parsed(response);
    assert.equal(value.activeTaskPolicy, undefined);
    matches.push(...value.matches.map(item => item.path));
    assert.ok(++pages <= 20, 'bounded continuation must make progress');
    if (!value.cursor) { assert.equal(value.searchComplete, true); break; }
    assert.equal(value.searchComplete, false);
    args = { action: 'find', cursor: value.cursor, limit: 17, timeoutMs: 10000 };
  }
  assert.equal(matches.length, 150);
  assert.equal(new Set(matches).size, 150);
  assert.equal(policyCalls, 0);
});

test('an explicitly named TAP log above both folder limits is searched, not silently skipped', async t => {
  const { handler, cwd } = await harness(t, { rgCommand: '__relay_missing_search_executable__' });
  await mkdir(path.join(cwd, 'dist'));
  const file = path.join(cwd, 'dist', 'overnight.tap');
  await writeFile(file, 'ok 123 - unrelated passing check\n'.repeat(36000) + 'not ok 456 - archive race\n');
  const response = await handler(call({ action: 'search', path: file, query: 'archive race', limit: 1 }));
  const found = parsed(response);
  assert.equal(response.success, true);
  assert.equal(found.scannedFiles, 1);
  assert.equal(found.truncated, false);
  assert.deepEqual(found.matches, [{path: file, line: 36001, text: 'not ok 456 - archive race'}]);
  const absent = parsed(await handler(call({ action: 'search', path: file, query: 'not in the log' })));
  assert.equal(absent.scannedFiles, 1);
  assert.equal(absent.truncated, false);
  assert.deepEqual(absent.matches, []);
});

test('workspace search distinguishes skipped files and an explicit oversized file from no matches', async t => {
  const { handler, cwd } = await harness(t, { rgCommand: '__relay_missing_search_executable__' });
  await writeFile(path.join(cwd, 'large.txt'), Buffer.alloc(513 * 1024, 65));
  const folder = parsed(await handler(call({ action: 'search', query: 'missing' })));
  assert.equal(folder.scannedFiles, 0);
  assert.equal(folder.skippedFiles, 1);
  assert.equal(folder.truncated, true);
  await writeFile(path.join(cwd, 'too-large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  const response = await handler(call({ action: 'search', path: 'too-large.txt', query: 'missing' }));
  assert.equal(response.success, false);
  assert.equal(parsed(response).code, 'WORKSPACE_SEARCH_FILE_TOO_LARGE');
  assert.match(parsed(response).error, /run action/);
});

test('content search coverage is opt-in, typed, and describes both bounded backends without private text', async t => {
  const {handler,cwd,events}=await harness(t,{captureSearchCoverage:true,rgCommand:'__relay_missing_search_executable__'});
  const sensitive='PRIVATE_SEARCH_NEEDLE', name='PRIVATE_SEARCH_FILE.tap';
  await writeFile(path.join(cwd,name), sensitive+' one\n'+sensitive+' two\n');
  await writeFile(path.join(cwd,'large.log'),'x'.repeat(550*1024));
  const search=(args,id)=>handler({...call({action:'search',query:sensitive,...args}),callId:id});
  const exact=await search({path:name},'c-file');
  assert.equal(parsed(exact).matches.length,2);
  const folder=await search({path:'.'},'c-folder');
  assert.equal(parsed(folder).skippedFiles,1);
  await search({limit:1},'c-working');
  await search({cwd:'.',caseSensitive:true},'c-explicit-cwd');
  const coverage=events.filter(e=>e.type==='workspace.search.coverage');
  assert.deepEqual(coverage.map(e=>[e.callId,e.searchScope,e.returnedMatches,e.truncated]),[
    ['c-file','explicit-file',2,false],['c-folder','explicit-folder',2,true],['c-working','working-folder',1,true],['c-explicit-cwd','explicit-working-folder',2,true]
  ]);
  assert.equal(coverage[0].searchBackend,'filesystem');
  assert.equal(coverage[0].searchRoute,'rg-unavailable');
  assert.equal(coverage[0].perFileByteLimit,16*1024*1024);
  assert.equal(coverage[1].perFileByteLimit,512*1024);
  assert.equal(coverage[2].matchLimit,1);
  assert.equal(coverage[0].timedOut,undefined);
  assert.equal(coverage[3].caseSensitive,true);
  assert.doesNotMatch(JSON.stringify(coverage),/PRIVATE_SEARCH|query|matches":\[/i);

  // The fallback handler's compiler-independent test above never requires rg.
  // This backend fixture emits exactly the stdout shape that rg would emit.
  const backendScript=path.join(cwd,'search-fake.cjs');
  await writeFile(backendScript,'process.stdout.write("PRIVATE_RESULT_1\\nPRIVATE_RESULT_2\\n")');
  const backend=await harness(t,{captureSearchCoverage:true,rgCommand:[process.execPath,backendScript]});
  const output=await backend.handler({...call({action:'search',query:sensitive,limit:1}),callId:'c-rg'});
  assert.equal(parsed(output).output,'PRIVATE_RESULT_1');
  const rg=backend.events.find(e=>e.type==='workspace.search.coverage');
  assert.deepEqual([rg.searchBackend,rg.searchRoute,rg.returnedMatches,rg.truncated,rg.timedOut],['rg','rg',1,true,false]);
  assert.equal(rg.scannedFiles,undefined);
  assert.doesNotMatch(JSON.stringify(rg),/PRIVATE/);

  const standard=await harness(t,{rgCommand:'__relay_missing_search_executable__'});
  await standard.handler(call({action:'search',query:sensitive}));
  assert.equal(standard.events.some(e=>e.type==='workspace.search.coverage'),false);
});

test('rg capture cap reports partial output without counting a trailing fragment as an exact result', async t => {
  const {cwd}=await harness(t);
  const script=path.join(cwd,'search-cap-fake.cjs');
  await writeFile(script,'process.stdout.write("VISIBLE_LINE\\n"+"PRIVATE_FRAGMENT".repeat(5000))');
  const {handler,events}=await harness(t,{rgCommand:[process.execPath,script],captureSearchCoverage:true});
  const response=await handler({...call({action:'search',query:'VISIBLE_LINE'}),callId:'capture-cap'});
  const body=parsed(response), coverage=events.find(e=>e.type==='workspace.search.coverage');
  assert.equal(response.success,true);
  assert.equal(body.truncated,true);
  assert.equal(body.preview,undefined);
  assert.equal(body.output.length,32000);
  assert.equal(coverage.truncated,true);
  assert.equal(coverage.resultPreviewOnly,false);
  assert.equal(coverage.returnedMatches,undefined);
  assert.doesNotMatch(JSON.stringify(coverage),/PRIVATE_FRAGMENT|VISIBLE_LINE/);
});


test('incremental file writes return complete hashes, preserve Unicode, and reject duplicate or stale chunks',async t=>{
  const {handler,cwd}=await harness(t);
  const target='large.txt',first='start\n'+'a'.repeat(800000),chunk='\nUnicode: \u{1f642}\n'+'b'.repeat(500000);
  const written=parsed(await handler(call({action:'write',path:target,text:first})));
  assert.match(written.sha256,/^[a-f0-9]{64}$/);
  const appended=await handler(call({action:'append',path:target,text:chunk,expectedHash:written.sha256}));
  assert.equal(appended.success,true,JSON.stringify(appended));
  const receipt=parsed(appended);
  assert.equal(receipt.beforeHash,written.sha256);assert.equal(receipt.status,'applied');assert.equal(receipt.atomic,true);
  assert.equal(await readFile(path.join(cwd,target),'utf8'),first+chunk);
  const info=parsed(await handler(call({action:'stat',path:target})));
  assert.equal(info.sha256,receipt.sha256);assert.equal(info.size,Buffer.byteLength(first+chunk));
  assert.equal(Object.hasOwn(info,'content'),false);
  const retry=await handler(call({action:'append',path:target,text:chunk,expectedHash:written.sha256}));
  assert.equal(retry.success,false);assert.equal(parsed(retry).actionDispatched,false);
  assert.equal(await readFile(path.join(cwd,target),'utf8'),first+chunk);
  const final=await handler(call({action:'append',path:target,text:'\nend',expectedHash:info.sha256}));
  assert.equal(final.success,true);assert.equal(await readFile(path.join(cwd,target),'utf8'),first+chunk+'\nend');
});
test('concurrent chunks using the same preimage cannot both be applied',async t=>{
  const {handler,cwd}=await harness(t);
  const initial=parsed(await handler(call({action:'write',path:'race.txt',text:'initial'})));
  const second=createWorkspaceToolHandler({cwd});
  const results=await Promise.all([handler,second].map((h,i)=>h(call({action:'append',path:'race.txt',text:String(i),expectedHash:initial.sha256}))));
  assert.equal(results.filter(r=>r.success).length,1);
  assert.equal(results.filter(r=>!r.success&&parsed(r).actionDispatched===false).length,1);
  assert.match(await readFile(path.join(cwd,'race.txt'),'utf8'),/^initial[01]$/);
  assert.deepEqual(await readdir(cwd),['race.txt']);
});
test('append validates preconditions, respects protected paths, and does not create missing targets',async t=>{
  const {handler,cwd}=await harness(t);
  const initial=parsed(await handler(call({action:'write',path:'protected.txt',text:'original'})));
  for(const args of [
    {action:'append',path:'protected.txt',text:'x'},
    {action:'append',path:'missing.txt',text:'x',expectedHash:initial.sha256},
    {action:'append',path:'protected.txt',text:'',expectedHash:initial.sha256}
  ]){
    const rejected=await handler(call(args));assert.equal(rejected.success,false,JSON.stringify(rejected));
    assert.equal(parsed(rejected).actionDispatched,false);
  }
  const protectedHandler=createWorkspaceToolHandler({cwd,protectedPaths:[path.join(cwd,'protected.txt')]});
  const denied=await protectedHandler(call({action:'append',path:'protected.txt',text:'x',expectedHash:initial.sha256}));
  assert.equal(denied.success,false);assert.equal(parsed(denied).code,'WORKSPACE_PROTECTED_PATH');
  assert.equal(await readFile(path.join(cwd,'protected.txt'),'utf8'),'original');
  assert.deepEqual(await readdir(cwd),['protected.txt']);
});
