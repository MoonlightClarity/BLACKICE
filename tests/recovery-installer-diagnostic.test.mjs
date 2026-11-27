import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=readFileSync(path.join(root,'scripts/verify-recovery-installer.ps1'),'utf8');
const workflow=readFileSync(path.join(root,'.github/workflows/verify-v2.40.85-installer-diagnostic.yml'),'utf8');

test('recovery installer diagnostic can run only on disposable GitHub-hosted Windows and exact recovery ref',()=>{
 assert.match(script,/\$IsWindows.*GITHUB_ACTIONS.*RUNNER_ENVIRONMENT.*github-hosted/);
 assert.match(script,/GITHUB_REF -ceq 'refs\/heads\/recovery\/full-lineage-24085-20261127'/);
 assert.match(script,/RUNNER_TEMP/);
 assert.match(script,/already contains a Relay user profile/i);
 assert.match(script,/Runner already has BLACKICE registry records/);
 assert.match(script,/Runner already has BLACKICE shortcuts/);
 assert.match(script,/Runner already has BLACKICE running/);
 assert.doesNotMatch(workflow,/branches:\s*\[main\]|contents:\s*write|gh release create|gh release edit|--publish\b/);
 assert.match(workflow,/contents:\s*read/);
 assert.match(workflow,/never creates a Git tag, draft, GitHub Release, or publication/);
});
test('recovery installation requires actual installer SHA, installed source fingerprint and native runtime checks',()=>{
 assert.match(script,/artifact\.sha256 -ceq \$hash/);
 assert.match(script,/pair\.source -ceq \$m\.appFingerprint/);
 assert.match(script,/pair\.installed -ceq \$m\.appFingerprint/);
 assert.match(script,/verify-installed-runtime\.mjs/);
 for(const key of ['startup','restart','window','shutdown','profileBackup','diagnostics']){
   assert.ok(script.includes("'"+key+"'"),key);
 }
 assert.match(script,/data-space="runtime"/);
 assert.match(script,/data-space="skills"/);
 assert.match(script,/Installed application not identical to source\/manifest fingerprint/);
 assert.match(script,/classification='recovery-installer-diagnostic-only'/);
 assert.match(script,/publicReleaseReady=\$false;published=\$false/);
});
test('published 2.40.84 upgrade uses a byte-verified baseline and preserves existing profile through upgrade/uninstall',()=>{
 assert.match(script,/releases\/download\/v2\.40\.84/);
 assert.match(script,/old\.artifact\.sha256 -ceq \(Hash \$oldSetup\)/);
 assert.match(script,/oldPair\.installed -ceq \$old\.appFingerprint/);
 assert.match(script,/CheckVersion \$exe '2\.40\.84'/);
 assert.match(script,/CheckVersion \$exe '2\.40\.85'/);
 assert.match(script,/Hash \$sentinel/);
 assert.match(script,/InvokeSetup \$uninstaller '\/S \/currentuser'/);
 assert.match(script,/Uninstall left the owned application directory/);
 assert.match(script,/Uninstaller altered persistent profile/);
});
test('installer diagnostics build once and run distinct clean and upgrade jobs in temporary hosted VMs',()=>{
 assert.match(workflow,/on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s+recovery\/full-lineage-24085-20261127/);
 assert.match(workflow,/node-version: '24\.22\.2'/);
 assert.match(workflow,/npm ci --no-audit --no-fund/);
 assert.match(workflow,/materialize-llama-repair\.mjs/);
 assert.match(workflow,/package:public/);
 for(const name of ['package-diagnostic','clean-install-diagnostic','published-24084-upgrade-diagnostic']){
   assert.match(workflow,new RegExp('\\s'+name+':'));
 }
 assert.match(workflow,/verify-recovery-installer\.ps1 -Mode clean/);
 assert.match(workflow,/verify-recovery-installer\.ps1 -Mode upgrade/);
 assert.match(workflow,/retention-days: 7/);
 assert.doesNotMatch(workflow,/release-request\.json|publish-windows-release/);
});
test('diagnostic evidence assignments cannot silently become standalone PowerShell commands',()=>{
 assert.doesNotMatch(script,/^\s*\$\s*$/gm,'A bare dollar sign is syntactically tolerated by PowerShell but fails at runtime.');
 for(const name of ['installerSha256','appFingerprint','baselineSha256','baselineFingerprint','shortcuts','runtime']){
   assert.match(script,new RegExp('\\$report\\["'+name+'"\\]\\s*='),'Missing bound diagnostic receipt field: '+name);
 }
 assert.match(script,/\$report\.passed=\$mainPassed -and \$cleanupPassed/);
 assert.match(script,/SavedReport/);
});
test('upgrade diagnostic uses canonical per-user installation without weakening real upgrade preflight',()=>{
 const guard=readFileSync(path.join(root,'desktop/upgrade-preflight.ps1'),'utf8');
 assert.match(script,/\$install=if\(\$Mode -eq 'upgrade'\) \{Join-Path \$env:LOCALAPPDATA 'Programs\\BLACKICE'\} else \{Join-Path \$work 'install'\}/);
 assert.match(guard,/Only the existing per-user BLACKICE installation can be updated/);
 assert.match(guard,/\$root -ine \$expected/);
 assert.doesNotMatch(guard,/RUNNER_TEMP|recovery-installer|diagnostic bypass/i);
 assert.match(script,/Installer returned nonzero exit code: '\+\(\$result -join ','\)/);
});