// A real noninteractive process fixture. Never connects to an email provider.
const [mode, ...args] = process.argv.slice(2);
if (mode === 'hang') {
  process.stdout.write(`${process.pid}\n`);
  setInterval(() => {}, 1000);
} else if (mode === 'oversized') {
  process.stdout.write('x'.repeat(4096));
  setInterval(() => {}, 1000);
} else if (mode === 'query-error') {
  process.stdout.write(JSON.stringify({ error: 'cannot parse search query', sources: ['PRIVATE_QUERY_DETAILS_DO_NOT_EXPOSE'] }));
  process.stderr.write('auth token=DO_NOT_LEAK_PRIVATE_VALUE'); process.exitCode = 1;
} else if (mode === 'failed') {
  process.stderr.write('auth token=DO_NOT_LEAK_PRIVATE_VALUE message=PRIVATE_BODY');
  process.exitCode = 9;
} else if (args.join(' ') === '--version') {
  process.stdout.write(mode === 'unsupported' ? 'himalaya 3.0.0\n' : 'himalaya v2.2.1 +imap +smtp\n');
} else if (args.includes('--help')) {
  process.stdout.write(mode === 'no-preview' ? '--json --page-size --page --mailbox --account' : '--json --page-size --page --mailbox --account --raw --seen Read, leaving its flags alone otherwise');
} else if (mode === 'bad-json') {
  process.stdout.write('not json');
} else if (args.includes('mailbox') && args.includes('list')) {
  if (args.includes('--counts')) { process.stderr.write('Unexpected mailbox count request'); process.exitCode = 7; }
  else process.stdout.write(JSON.stringify({ mailboxes: [{ id: 'INBOX', name: 'INBOX', role: 'inbox', total: null, unread: null }, { id: 'archive-id', name: 'Archive & receipts', role: null, total: null, unread: null }] }));
} else if (args.includes('envelope')) {
  const query = args.indexOf('--');
  const envelopes = [{ id: '42', 'message-id': 'fixture@example.invalid', 'in-reply-to': [], subject: 'Fixture message', from: [{ name: 'Fixture', email: 'fixture@example.invalid' }], to: [{ name: null, email: 'reader@example.invalid' }], flags: [], date: '2024-10-01T12:00:00Z', size: 319, 'has-attachment': false, receivedQuery: query < 0 ? '' : args[query + 1], receivedArgs: args, receivedCwd: process.cwd() }];
  process.stdout.write(JSON.stringify(mode === 'legacy-array' ? envelopes : { queued: mode === 'indexing' ? 3 : 0, envelopes }));
} else if (args.includes('read')) {
  if (!args.includes('--raw') || args.includes('--seen')) { process.stderr.write('Refusing a read that could change Seen'); process.exitCode = 7; }
  else {
    const message = 'From: fixture@example.invalid\nSubject: Fixture message\n\nA harmless fixture body.';
    process.stdout.write(JSON.stringify(mode === 'legacy-read-string' ? message : { message }));
  }
} else {
  process.stderr.write('Unsupported fixture command'); process.exitCode = 3;
}
