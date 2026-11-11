import { readFile } from 'node:fs/promises';
import path from 'node:path';

const failure = (message) => Object.assign(new Error(message), { code: 'QWEN3_TOKENIZER_ERROR' });
const byteToUnicode = (() => {
  const reserved = [
    ...Array.from({ length: 94 }, (_, i) => i + 33),
    ...Array.from({ length: 12 }, (_, i) => i + 161),
    ...Array.from({ length: 82 }, (_, i) => i + 174),
  ];
  const occupied = new Set(reserved), mapped = Array(256);
  let extra = 256;
  for (const byte of reserved) mapped[byte] = String.fromCodePoint(byte);
  for (let i = 0; i < 256; i++) if (!occupied.has(i)) mapped[i] = String.fromCodePoint(extra++);
  return mapped;
})();
const unicodeToByte = new Map(byteToUnicode.map((character, i) => [character, i]));
const preTokenRegex = /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;
const tagEscape = input => input.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

export class Qwen3Tokenizer {
  constructor(config) {
    if (!config || config.model?.type !== 'BPE' || !config.model.vocab || !Array.isArray(config.model.merges))
      throw failure('Expected a Qwen3 byte-level BPE tokenizer.json.');
    if (config.normalizer?.type !== 'NFC' ||
        config.pre_tokenizer?.type !== 'Sequence' ||
        config.pre_tokenizer.pretokenizers?.length !== 2 ||
        config.pre_tokenizer.pretokenizers[0]?.type !== 'Split' ||
        config.pre_tokenizer.pretokenizers[1]?.type !== 'ByteLevel' ||
        config.pre_tokenizer.pretokenizers[1]?.add_prefix_space !== false ||
        config.decoder?.type !== 'ByteLevel') {
      throw failure('Unsupported tokenizer normalization, split, or byte-decoding configuration.');
    }
    const split = config.pre_tokenizer.pretokenizers[0];
    if (split.pattern?.Regex !== "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+" ||
      split.behavior !== 'Isolated') throw failure('Unsupported Qwen3 pretokenizer pattern.');

    this.vocab = new Map(Object.entries(config.model.vocab));
    this.byId = new Map([...this.vocab].map(([value, id]) => [id, value]));
    this.merges = new Map();
    for (let rank = 0; rank < config.model.merges.length; rank++) {
      const raw = config.model.merges[rank];
      const pair = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(' ') : null;
      if (!pair || pair.length !== 2) throw failure('Unsupported BPE merge format.');
      this.merges.set(pair[0] + '\0' + pair[1], rank);
    }
    this.addedTokens = new Map();
    this.specialIds = new Map();
    for (const entry of config.added_tokens || []) {
      if (typeof entry.content !== 'string' || !Number.isSafeInteger(entry.id))
        throw failure('Invalid added-token metadata.');
      this.addedTokens.set(entry.content, entry.id);
      if (entry.special === true) this.specialIds.set(entry.id, entry.content);
      this.byId.set(entry.id, entry.content);
    }
    // Qwen3's <think> and </think> are added tokens but not necessarily
    // marked "special" in tokenizer.json. They still need exact IDs.
    const specials = [...this.addedTokens.keys()].sort((a, b) => b.length - a.length);
    this.specialRegex = specials.length ? new RegExp('(' + specials.map(tagEscape).join('|') + ')', 'g') : null;
    this.id = value => {
      const id = this.addedTokens.get(value);
      if (id === undefined) throw failure('Qwen3 added token is unavailable: ' + value);
      return id;
    };
    this.eosId = this.id('<|im_end|>');
    this.cache = new Map();
  }

  static async load(modelDirectory) {
    const file = path.join(path.resolve(modelDirectory), 'tokenizer.json');
    return new Qwen3Tokenizer(JSON.parse(await readFile(file, 'utf8')));
  }

  bpe(part) {
    if (this.cache.has(part)) return this.cache.get(part);
    const symbols = Array.from(Buffer.from(part, 'utf8'), byte => byteToUnicode[byte]);
    while (symbols.length > 1) {
      let best = Infinity, index = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.merges.get(symbols[i] + '\0' + symbols[i + 1]);
        if (rank !== undefined && rank < best) { best = rank; index = i; }
      }
      if (index < 0) break;
      symbols.splice(index, 2, symbols[index] + symbols[index + 1]);
    }
    const ids = symbols.map(symbol => {
      const id = this.vocab.get(symbol);
      if (id === undefined) throw failure('BPE token is missing from the tokenizer vocabulary.');
      return id;
    });
    if (this.cache.size >= 8192) this.cache.clear();
    this.cache.set(part, ids);
    return ids;
  }

  encodeText(raw) {
    if (typeof raw !== 'string') throw failure('Tokenization input must be text.');
    const input = raw.normalize('NFC');
    if (!input) return [];
    const fragments = input.match(preTokenRegex);
    if (!fragments || fragments.join('') !== input) throw failure('Qwen3 pretokenizer cannot represent the supplied text.');
    return fragments.flatMap(part => this.bpe(part));
  }

  /** Special delimiters are opt-in. Chat message content never parses user-supplied special tags as control tokens. */
  encode(input, { allowSpecial = false } = {}) {
    if (typeof input !== 'string') throw failure('Tokenization input must be text.');
    if (!allowSpecial || !this.specialRegex) return this.encodeText(input);
    this.specialRegex.lastIndex = 0;
    const result = [];
    let start = 0;
    for (const match of input.matchAll(this.specialRegex)) {
      if (match.index > start) result.push(...this.encodeText(input.slice(start, match.index)));
      result.push(this.id(match[0]));
      start = match.index + match[0].length;
    }
    if (start < input.length) result.push(...this.encodeText(input.slice(start)));
    return result;
  }

  /** Minimal strict Qwen3 chat template for ordinary system/user/assistant text (no tool calls). */
  encodeChat(messages, { addGenerationPrompt = true, enableThinking = true } = {}) {
    if (!Array.isArray(messages) || !messages.length) throw failure('Provide one or more chat messages.');
    const result = [];
    for (const message of messages) {
      if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string')
        throw failure('Only system, user, and assistant text messages are supported by the reference chat template.');
      result.push(this.id('<|im_start|>'), ...this.encodeText(message.role + '\n'));
      result.push(...this.encode(message.content, { allowSpecial: false }));
      result.push(this.id('<|im_end|>'), ...this.encodeText('\n'));
    }
    if (addGenerationPrompt) {
      result.push(this.id('<|im_start|>'), ...this.encodeText('assistant\n'));
      if (!enableThinking) result.push(this.id('<think>'), ...this.encodeText('\n\n'), this.id('</think>'), ...this.encodeText('\n\n'));
    }
    return result;
  }

  /** Streaming decoder carries partial UTF-8 byte sequences across token boundaries. */
  newDecoder({ skipSpecialTokens = true } = {}) {
    let decoder = new TextDecoder('utf-8', { fatal: false });
    return {
      push: id => {
        const symbol = this.byId.get(id);
        if (symbol === undefined) throw failure('Unknown Qwen3 token ID: ' + id);
        if (this.specialIds.has(id)) {
          if (skipSpecialTokens) return '';
          const previous = decoder.decode();
          decoder = new TextDecoder('utf-8', { fatal: false });
          return previous + symbol;
        }
        const codepoints = Array.from(symbol);
        const bytes = new Uint8Array(codepoints.map(point => {
          const value = unicodeToByte.get(point);
          if (value === undefined) throw failure('Vocabulary contains non-byte-level symbols.');
          return value;
        }));
        return decoder.decode(bytes, { stream: true });
      },
      finish: () => decoder.decode(),
    };
  }

  decode(ids, { skipSpecialTokens = true } = {}) {
    const decoder = this.newDecoder({ skipSpecialTokens });
    let text = '';
    for (const id of ids) text += decoder.push(id);
    return text + decoder.finish();
  }
}
