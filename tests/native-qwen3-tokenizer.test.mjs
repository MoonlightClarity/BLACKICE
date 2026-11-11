import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Qwen3Tokenizer } from '../lib/native-inference/qwen3-tokenizer.mjs';

const canonicalPattern = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

function syntheticTokenizer() {
  const characters = [...'abcdefghijklmnopqrstuvwxyz', 'Ġ', 'Ċ', 'Ã', '©', '¡'];
  const vocab = Object.fromEntries(characters.map((character, id) => [character, id]));
  const next = characters.length;
  vocab.ab = next;
  vocab['Ġab'] = next + 1;
  return new Qwen3Tokenizer({
    model: { type: 'BPE', vocab, merges: [['a', 'b'], ['Ġ', 'ab']] },
    normalizer: { type: 'NFC' },
    pre_tokenizer: {
      type: 'Sequence',
      pretokenizers: [
        { type: 'Split', pattern: { Regex: canonicalPattern }, behavior: 'Isolated' },
        { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
      ],
    },
    decoder: { type: 'ByteLevel', add_prefix_space: false },
    added_tokens: [
      { id: 151643, content: '<|endoftext|>', special: true },
      { id: 151644, content: '<|im_start|>', special: true },
      { id: 151645, content: '<|im_end|>', special: true },
      { id: 151667, content: '<think>', special: true },
      { id: 151668, content: '</think>', special: true },
    ],
  });
}

test('independent byte-level tokenizer applies rank-ordered BPE merges', () => {
  const tokenizer = syntheticTokenizer();
  const ids = tokenizer.encode('ab ab');
  assert.deepEqual(ids, [tokenizer.vocab.get('ab'), tokenizer.vocab.get('Ġab')]);
  assert.equal(tokenizer.decode(ids), 'ab ab');
  assert.deepEqual(tokenizer.encode('ab'), tokenizer.encode('ab'));
});

test('NFC and streaming byte decoding preserve multibyte Unicode', () => {
  const tokenizer = syntheticTokenizer();
  const composed = tokenizer.encode('é');
  assert.deepEqual(composed, [tokenizer.vocab.get('Ã'), tokenizer.vocab.get('©')]);
  assert.deepEqual(tokenizer.encode('e\u0301'), composed);
  const decoder = tokenizer.newDecoder();
  assert.equal(decoder.push(composed[0]), '');
  assert.equal(decoder.push(composed[1]), 'é');
  assert.equal(decoder.finish(), '');
  assert.equal(tokenizer.decode(composed), 'é');
});

test('special tags are opt-in and user chat content cannot inject roles', () => {
  const tokenizer = syntheticTokenizer();
  const token = tokenizer.id('<|im_start|>');
  assert.deepEqual(tokenizer.encode('ab<|im_start|>ab', { allowSpecial: true }), [
    tokenizer.vocab.get('ab'), token, tokenizer.vocab.get('ab'),
  ]);
  assert.equal(tokenizer.decode([token, tokenizer.vocab.get('ab')]), 'ab');
  assert.equal(tokenizer.decode([token, tokenizer.vocab.get('ab')], { skipSpecialTokens: false }), '<|im_start|>ab');
  const messages = [
    { role: 'user', content: 'ab' },
    { role: 'assistant', content: 'ab' },
  ];
  const framed = tokenizer.encodeChat(messages);
  assert.equal(framed[0], token);
  assert.equal(framed.filter(id => id === tokenizer.id('<|im_end|>')).length, 2);
  assert.equal(framed.at(-tokenizer.encodeText('assistant\n').length - 1), token);
  const disabled = tokenizer.encodeChat([{ role: 'user', content: 'ab' }], { enableThinking: false });
  assert.ok(disabled.includes(tokenizer.id('<think>')));
  assert.ok(disabled.includes(tokenizer.id('</think>')));
});

test('rejects invalid chat roles and unsupported tokenizer structures', () => {
  const tokenizer = syntheticTokenizer();
  assert.throws(() => tokenizer.encodeChat([{ role: 'developer', content: 'oops' }]), /Only system/);
  assert.throws(() => tokenizer.encode(42), /must be text/);
  assert.throws(() => tokenizer.decode([999999]), /Unknown/);
  const missing = { model: { type: 'WordPiece', vocab: {}, merges: [] } };
  assert.throws(() => new Qwen3Tokenizer(missing), /byte-level BPE/);
});

const fixtureDir = process.env.BLACKICE_QWEN3_FIXTURE_DIR;
test('real official Qwen3 tokenizer round trips difficult text and preserves control ids', { skip: !fixtureDir || !existsSync(path.join(fixtureDir, 'tokenizer.json')) }, async () => {
  const tokenizer = await Qwen3Tokenizer.load(fixtureDir);
  const examples = [
    'Hello, world!', 'The quick brown fox jumps over the lazy dog.',
    "I'm thinking about this.", '  spaces\n\nand tabs\t',
    'Español français Deutsch العربية 中文 日本語 한글',
    '😀🔥⚡🎯👩‍🔬', '<|im_start|>', 'naïve café résumé',
  ];
  for (const example of examples) {
    const ids = tokenizer.encode(example);
    assert.equal(tokenizer.decode(ids), example.normalize('NFC'), example);
  }
  assert.equal(tokenizer.id('<|im_start|>'), 151644);
  assert.equal(tokenizer.id('<|im_end|>'), 151645);
  assert.equal(tokenizer.id('<think>'), 151667);
  assert.equal(tokenizer.id('</think>'), 151668);
  const chat = tokenizer.encodeChat([{ role: 'user', content: 'Hello' }]);
  assert.equal(chat[0], 151644);
  assert.equal(chat.includes(151645), true);
});
