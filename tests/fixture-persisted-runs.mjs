import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// Query the committed store independently, including after engine shutdown.
// readOnly prevents creating a missing database or repairing the fixture under test.
export function persistedRunRows(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'run-state.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT payload FROM records ORDER BY rowid').all().map(row => JSON.parse(row.payload));
  } finally {
    db.close();
  }
}
