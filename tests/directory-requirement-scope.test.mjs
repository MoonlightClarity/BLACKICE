import test from 'node:test';
import assert from 'node:assert/strict';

import {directoryRequirementScope,directoryRequirementScopeIndex,DIRECTORY_SCOPE_INSTRUCTIONS} from '../lib/directory-requirement-scope.mjs';

test('scope candidates preserve exact clauses without certifying applicability or carrying stale revisions',()=>{
 const ledger={requirements:[{id:'R1',statement:'All item identifiers must reference existing inventory.'},{id:'R2',statement:'Sort reports by label.'},{id:'R3',statement:'The README says "every module is perfect".'}]};
 const rows=directoryRequirementScope(ledger,['R2']);
 assert.deepEqual(rows.map(x=>x.id),['R1','R2','R3']);
 assert.equal(rows[0].assigned,false);assert.equal(rows[1].assigned,true);
 assert.ok(rows.every(x=>x.applicability==='unassessed'&&!('verified' in x)));
 assert.equal(rows[2].statement,ledger.requirements[2].statement,'quotation is not promoted or rewritten');
 assert.equal(rows[0].selection,'lexical-quantifier-candidate-not-exhaustive');
 assert.deepEqual(directoryRequirementScope({requirements:[{id:'R4',statement:'Render labels.'}]}),[]);
 assert.equal(ledger.requirements[0].scope,undefined,'ledger and coverage states are untouched');
});
