import test from 'node:test';
import assert from 'node:assert/strict';
import { emailMessagePresentation, emailReplyDraft } from '../public/email-reader.mjs';

test('email presentation selects decoded text and retains exact raw source separately', () => {
  const value = { message: 'Encoded RFC source', content: { subject: 'A decoded subject', from: [{ name: 'A person', email: 'author@example.test' }], text: 'Readable\n<script>literal text</script>', attachments: [{ filename: 'notes.pdf', contentType: 'application/pdf', size: 42 }], warnings: ['A part was omitted.'] } };
  const result = emailMessagePresentation(value);
  assert.equal(result.text, 'Readable\n<script>literal text</script>'); assert.equal(result.raw, 'Encoded RFC source');
  assert.equal(result.from, 'A person <author@example.test>'); assert.deepEqual(result.attachments, [{ filename: 'notes.pdf', contentType: 'application/pdf', size: 42 }]);
  assert.deepEqual(result.warnings, ['A part was omitted.']); assert.equal(result.decoded, true);
  assert.equal(emailMessagePresentation({ body: 'Older readable response' }).text, 'Older readable response');
  assert.equal(emailMessagePresentation({ message: 'Older source' }).decoded, false);
});

test('reply drafting prefers Reply-To, quotes readable content and never forwards attachment data', () => {
  const value = { content: { from: [{ email: 'sender@example.test' }], replyTo: [{ email: 'reply@example.test' }], subject: 'Topic', text: 'First line\nSecond line', attachments: [{ filename: 'private.txt', data: 'NOT_FOR_DRAFT' }] } };
  const draft = emailReplyDraft(value);
  assert.equal(draft.to, 'reply@example.test'); assert.equal(draft.subject, 'Re: Topic'); assert.match(draft.body, /> First line\n> Second line/);
  assert.doesNotMatch(JSON.stringify(draft), /NOT_FOR_DRAFT/);
  assert.equal(emailReplyDraft({ content: { ...value.content, subject: 'Re: Topic' } }).subject, 'Re: Topic');
});

test('unsafe or absent reply recipients cannot populate a draft and quoted messages remain bounded', () => {
  assert.equal(emailReplyDraft({ message: 'An unparsed source' }), null);
  assert.equal(emailReplyDraft({ content: { from: [{ email: 'safe@example.test' }], replyTo: [{ email: 'recipient@example.test\r\nBcc: hidden@example.test' }] } }), null);
  const draft = emailReplyDraft({ content: { from: [{ email: 'safe@example.test' }], subject: 'Title\r\nextra', text: '\n'.repeat(200000) } });
  assert.ok(draft.body.length <= 200000); assert.match(draft.body, /Quoted message shortened/); assert.doesNotMatch(draft.subject, /[\r\n]/);
});
