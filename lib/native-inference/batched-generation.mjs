import { prefillQwen3 } from './batched-prefill.mjs';

const error = message => Object.assign(new Error(message), { code: 'BLACKICE_BATCHED_GENERATION' });

/** First-party prefill + sequential decode. No implicit external fallback.
 * The prompt is processed by batched Qwen3 matrix projections; generated
 * tokens still use the validated single-token step() implementation.
 */
export async function generateQwen3Batched(model, tokenIds, {
  projector, blockSize = 64, maxNewTokens = 16, onToken, signal,
} = {}) {
  if (!model || typeof model.step !== 'function' || typeof model.reset !== 'function')
    throw error('A loaded BLACKICE Qwen3 reference model is required.');
  if (!Array.isArray(tokenIds) || !tokenIds.length || !tokenIds.every(Number.isSafeInteger))
    throw error('Provide a nonempty list of integer token IDs.');
  if (!Number.isSafeInteger(maxNewTokens) || maxNewTokens < 0 || maxNewTokens > 2048)
    throw error('Generation output token budget must be 0 to 2048.');
  signal?.throwIfAborted();
  model.reset();
  let logits = await prefillQwen3(model, tokenIds, { projector, blockSize, signal });
  const generated = [];
  for (let next = 0; next < maxNewTokens; next++) {
    signal?.throwIfAborted();
    let tokenId = 0;
    for (let id = 1; id < logits.length; id++)
      if (logits[id] > logits[tokenId]) tokenId = id;
    generated.push(tokenId);
    if (onToken) await onToken(tokenId);
    signal?.throwIfAborted();
    if (tokenId === model.config.eos_token_id) break;
    if (next < maxNewTokens - 1) logits = await model.step(tokenId, { signal });
  }
  return generated;
}
