import fs from 'node:fs';
import path from 'node:path';

// This is an availability guard, not a replacement for immutable SHA-256 pins.
// A present but partial/corrupt historical tree must execute the original suite
// and fail its own pinned-file verification.
export function classifyHistoricalSnapshot(baseRoot) {
  if (typeof baseRoot !== 'string' || !path.isAbsolute(baseRoot)) throw new TypeError('A frozen absolute base root is required.');
  const historicalRoot = path.dirname(path.dirname(baseRoot));
  return {historicalRoot, available: fs.existsSync(historicalRoot)};
}
