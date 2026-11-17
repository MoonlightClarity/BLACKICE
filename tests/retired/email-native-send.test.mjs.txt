import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentEmailStore } from '../lib/agent-email.mjs';
import { parseEmailMessage } from '../lib/email-message.mjs';

// Opt-in dependency test. The explicit CLI receives ONLY this disposable config,
// with a loopback SMTP server and reserved .invalid recipients, never a live account.
const executable = process.env.BLACKICE_EMAIL_NATIVE_CLI;
test('installed Himalaya sends exact MIME to disposable loopback SMTP and strips Bcc headers', { skip: !executable }, async t => {
  assert.ok(path.isAbsolute(executable));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-native-smtp-test-'));
  const sockets = new Set(), sessions = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const session = { recipients: [], data: '' }; sessions.push(session);
    let buffer = '', receiving = false;
    socket.write('220 localhost disposable fixture\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (receiving) {
          if (line === '.') { receiving = false; socket.write('250 accepted by local fixture\r\n'); }
          else session.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
        } else if (/^(EHLO|HELO)/i.test(line)) socket.write('250-localhost\r\n250-8BITMIME\r\n250 SIZE 40000000\r\n');
        else if (/^RCPT TO:/i.test(line)) { session.recipients.push(line); socket.write('250 ok\r\n'); }
        else if (/^DATA$/i.test(line)) { receiving = true; socket.write('354 continue\r\n'); }
        else if (/^QUIT$/i.test(line)) socket.end('221 goodbye\r\n');
        else if (/^(MAIL FROM:|RSET|NOOP)/i.test(line)) socket.write('250 ok\r\n');
        else socket.write('502 unsupported fixture command\r\n');
      }
    });
  });
  let store;
  t.after(async () => {
    await store?.close(); for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('blackice-native-smtp-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const configPath = path.join(directory, 'fixture.toml');
  await fs.writeFile(configPath, `[accounts.fixture]\nsmtp.server = "smtp://127.0.0.1:${server.address().port}"\nmessage.send.save-copy = false\n`);
  store = await new AgentEmailStore({ dataDir: directory }).init();
  await store.configure({ enabled: true, executable, configPath, account: 'fixture', timeoutMs: 5000 }); await store.check();
  const attachment = path.join(directory, 'résumé fixture.pdf'), binary = Buffer.from([0, 255, 13, 10, 128, 37, 80, 68, 70]);
  await fs.writeFile(attachment, binary);
  const message = await store.compose({ requestId: 'native-compose', from: 'sender@example.invalid', to: ['visible@example.invalid'], cc: ['copy@example.invalid'], bcc: ['blind@example.invalid'], subject: 'Local attachment proof ✓', body: 'Fixture résumé body.', attachments: [attachment] });
  const sent = await store.send({ id: message.id, requestId: 'native-send' });
  assert.equal(sent.state, 'sent'); assert.equal(sent.transportAccepted, true); assert.equal(sent.recipientAcknowledged, false);
  const received = sessions.find(session => session.data); assert.ok(received);
  assert.equal(received.recipients.length, 3); assert.ok(received.recipients.includes('RCPT TO:<blind@example.invalid>'));
  assert.equal(/^bcc:/im.test(received.data), false);
  assert.ok(received.data.includes(message.messageId)); assert.ok(received.data.includes(binary.toString('base64')));
  const parsed = parseEmailMessage(received.data);
  assert.equal(parsed.subject, 'Local attachment proof ✓'); assert.equal(parsed.text.trim(), 'Fixture résumé body.');
  assert.equal(parsed.attachments[0].filename, 'résumé fixture.pdf'); assert.equal(parsed.attachments[0].size, binary.length);
  assert.equal((await store.send({ id: message.id, requestId: 'native-send' })).duplicate, true);
  assert.equal(sessions.filter(session => session.data).length, 1);
});
