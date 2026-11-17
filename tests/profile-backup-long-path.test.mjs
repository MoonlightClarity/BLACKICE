import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProfileBackup,verifyProfileBackup,restoreProfileBackup} from '../lib/profile-backup.mjs';
const binding={platform:'win32',userIdHash:'a'.repeat(64),machineIdHash:'b'.repeat(64)};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-backup-long-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const parent=path.join(root,'ordinary-directory-'.repeat(7)),profileDir=path.join(parent,'profile'),backupDir=path.join(parent,'backup');
 await fs.mkdir(path.join(profileDir,'data','direct-execution-jobs'),{recursive:true});
 const relative=path.join('data','direct-execution-jobs','direct_'+'a'.repeat(64)+'.json'),file=path.join(profileDir,relative);
 assert.ok(file.length>260);await fs.writeFile(file,'preserved fixture');
 return{root,parent,profileDir,backupDir,relative,file,args:{profileDir,backupDir,appVersion:'2.39.104',getBinding:async()=>binding,isProcessAlive:()=>false}};
}
test('real Windows backup verifies and restores ordinary paths beyond MAX_PATH without bypassing reparse inspection',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await fixture(t),backup=await createProfileBackup(f.args);
 assert.equal(backup.files,1);assert.equal((await verifyProfileBackup(f.args)).manifestSha256,backup.manifestSha256);
 await fs.writeFile(f.file,'newer fixture');const restored=await restoreProfileBackup(f.args);
 assert.equal(restored.restored,true);assert.equal(await fs.readFile(f.file,'utf8'),'preserved fixture');
 assert.equal(await fs.readFile(path.join(restored.previousProfileDir,f.relative),'utf8'),'newer fixture');
});
test('real Windows long-path backup still rejects source and payload junctions without reading outside the profile',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'untouched.txt'),'outside fixture');
 const link=path.join(f.profileDir,'data','junction');await fs.symlink(outside,link,'junction');
 await assert.rejects(createProfileBackup(f.args),{code:'PROFILE_BACKUP_UNSAFE_PATH'});await fs.unlink(link);
 await createProfileBackup(f.args);await fs.symlink(outside,path.join(f.backupDir,'payload','junction'),'junction');
 await assert.rejects(verifyProfileBackup(f.args),{code:'PROFILE_BACKUP_UNSAFE_PATH'});
 assert.equal(await fs.readFile(path.join(outside,'untouched.txt'),'utf8'),'outside fixture');assert.equal(await fs.readFile(f.file,'utf8'),'preserved fixture');
});
