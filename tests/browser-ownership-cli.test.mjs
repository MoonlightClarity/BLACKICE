import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserArgs, desktopBrowserArgs, browserCLIRequest } from '../lib/browser-cli.mjs';
test('ownership CLI aliases retain explicit target guards and local direct identity', async () => {
  const args = ['--take_ownership','--tab=one','--expected-url=https://example.com/','--expected-document=one:2','--request-id=take-one'];
  assert.deepEqual(desktopBrowserArgs(['BLACKICE.exe',...args]), ['browser',...args]);
  const parsed = parseBrowserArgs(args), request = await browserCLIRequest(parsed);
  assert.equal(request.tool,'blackice_browser_action'); assert.deepEqual(request.arguments,{requestId:'take-one',action:'take_ownership',browser:'relay',tabId:'one',expectedUrl:'https://example.com/',expectedDocumentId:'one:2'});
  const transfer = await browserCLIRequest(parseBrowserArgs(['--transfer_ownership',...args.slice(1),'--destination=user']));
  assert.equal(transfer.arguments.action,'transfer_ownership'); assert.equal(transfer.arguments.destination,'user');
  assert.throws(()=>parseBrowserArgs(['--take_ownership','--tab=one']), {code:'BROWSER_CLI_ARGUMENTS'});
  assert.throws(()=>parseBrowserArgs([...args,'--owner=arbitrary']), {code:'BROWSER_CLI_ARGUMENTS'});
});
test('diagnostics CLI preserves bounded cursor arguments', async () => {
  const request = await browserCLIRequest(parseBrowserArgs(['diagnostics','--tab=one','--after=3','--limit=12','--request-id=diag-one']));
  assert.equal(request.tool,'blackice_browser_read'); assert.equal(request.arguments.after,3); assert.equal(request.arguments.limit,12);
});
