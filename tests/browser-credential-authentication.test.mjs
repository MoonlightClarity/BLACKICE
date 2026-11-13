import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {BrowserCredentialVault} from '../lib/browser-credentials.mjs';
async function fixture(t) {
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-auth-ledger-')),key=randomBytes(32);
 const options={dataDir,storageBackend:'dpapi',isEncryptionAvailable:()=>true,
 encryptSecret(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},
 decryptSecret(raw){const b=Buffer.from(raw),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();}};
 const vault=await new BrowserCredentialVault(options).init();
 t.after(async()=>{await vault.close();await rm(dataDir,{recursive:true,force:true});});
 const credential=await vault.generate({origin:'https://auth.example.test',username:'fixture',requestId:'generate_fixture'},{ownerId:'fixture'});
 return {vault,options,input:{credentialId:credential.credentialId,revision:credential.revision,origin:credential.origin,intent:'login',requestId:'auth_once',expectedDocumentId:'doc',submitRef:'submit'},auth:{ownerId:'fixture',beforeDispatch:async()=>{}}};
}
test('authentication is durable single-dispatch and never claims authenticated status',async t=>{
 const f=await fixture(t);let calls=0;
 const op=async(secret,mark)=>{assert.ok(secret.password);await mark();calls++;return{submissionRequested:true};};
 const result=await f.vault.authenticateOnce(f.input,op,f.auth);assert.equal(result.outcome,'dispatched');assert.equal(result.authenticated,false);
 assert.equal((await f.vault.authenticateOnce(f.input,op,f.auth)).existing,true);assert.equal(calls,1);
 const reopened=await new BrowserCredentialVault(f.options).init();
 assert.equal((await reopened.authenticateOnce(f.input,op,f.auth)).existing,true);assert.equal(calls,1);await reopened.close();
});
test('secret-containing thrown result after dispatch is unknown and not replayed',async t=>{
 const f=await fixture(t);let calls=0,secretValue;
 const op=async(secret,mark)=>{secretValue=secret.password;await mark();calls++;throw Error(secret.password);};
 const result=await f.vault.authenticateOnce(f.input,op,f.auth);assert.equal(result.outcome,'unknown');assert.equal(result.submissionRequested,null);assert.ok(!JSON.stringify(result).includes(secretValue));
 assert.equal((await f.vault.authenticateOnce(f.input,op,f.auth)).existing,true);assert.equal(calls,1);
});
test('failure before dispatch is not misreported as submitted',async t=>{
 const f=await fixture(t);await assert.rejects(f.vault.authenticateOnce(f.input,async()=>{throw Error('fixture');},f.auth),{code:'CREDENTIAL_AUTH_NOT_DISPATCHED'});
 let calls=0;await f.vault.authenticateOnce(f.input,async(_,mark)=>{await mark();calls++;return{submissionRequested:true};},f.auth);assert.equal(calls,1);
});
test('changed operation binding conflicts with prior dispatch',async t=>{
 const f=await fixture(t);const op=async(_,mark)=>{await mark();return{submissionRequested:true};};await f.vault.authenticateOnce(f.input,op,f.auth);
 await assert.rejects(f.vault.authenticateOnce({...f.input,submitRef:'changed'},op,f.auth),{code:'CREDENTIAL_REQUEST_CONFLICT'});
});
test('missing or revoked host authority and unsupported intent do not dispatch',async t=>{
 const f=await fixture(t);let calls=0;const op=async()=>{calls++;};
 await assert.rejects(f.vault.authenticateOnce(f.input,op,{ownerId:'fixture'}),{code:'CREDENTIAL_AUTH_AUTHORITY'});
 await assert.rejects(f.vault.authenticateOnce(f.input,op,{...f.auth,beforeDispatch:async()=>{throw Error('revoked');}}));
 await assert.rejects(f.vault.authenticateOnce({...f.input,intent:'password-reset'},op,f.auth),{code:'CREDENTIAL_AUTH_ACTION'});assert.equal(calls,0);
});

import {createBrowserCredentialToolHandler,createDirectBrowserCredentialTools} from '../lib/browser-credential-tools.mjs';
const toolTarget={action:'authenticate',origin:'https://auth.example.test',credentialId:'credential_fixture',revision:1,browser:'relay',tabId:'tab',expectedUrl:'https://auth.example.test/login',expectedDocumentId:'doc',passwordRef:'password',submitRef:'submit',intent:'login',requestId:'once'};
test('native authentication requires host callback and preserves uncertain dispatch receipt',async()=>{
 let calls=0,checks=0;
 const browser={status:()=>({available:true,contained:true}),fillCredential(){},async authenticateCredential(args,options){calls++;await options.beforeDispatch({action:'authenticate',intent:args.intent,origin:args.origin});return{outcome:'unknown',submissionRequested:null,authenticated:false};}};
 const vault={status:async()=>({available:true,healthy:true})};
 const blocked=createBrowserCredentialToolHandler({vault,browser,ownerId:'native-task'});
 assert.equal((await blocked({name:'relay_credentials',arguments:toolTarget})).success,false);assert.equal(calls,0);
 const handler=createBrowserCredentialToolHandler({vault,browser,ownerId:'native-task',beforeDispatch:async()=>{checks++;}});
 const result=await handler({name:'relay_credentials',arguments:toolTarget});
 assert.equal(result.success,true);assert.equal(JSON.parse(result.contentItems[0].text).outcome,'unknown');assert.ok(checks>=2);assert.equal(calls,1);
 const malformed=await handler({name:'relay_credentials',arguments:{...toolTarget,authorized:true}});assert.equal(malformed.success,false);assert.equal(calls,1);
});
test('direct authentication schema and callback retain stable request ID and exact origin',async()=>{
 let calls=0,checks=0;
 const tools=createDirectBrowserCredentialTools({vault:{status:async()=>({available:true,healthy:true})},browser:{status:()=>({available:true,contained:true}),fillCredential(){},async authenticateCredential(args,options){assert.equal(args.requestId,'once');assert.equal(args.origin,toolTarget.origin);await options.beforeDispatch({action:'authenticate',origin:args.origin,intent:args.intent});calls++;return{outcome:'dispatched',submissionRequested:true,authenticated:false};}},reauthorize:async()=>{checks++;}});
 const tool=tools.find(t=>t.definition.name==='blackice_credentials_authenticate');assert.ok(tool);
 const {action,...args}=toolTarget;const result=await tool.execute(args,{client:{id:'test-client'}});
 assert.equal(result.success,true);assert.equal(calls,1);assert.ok(checks>=3);
});
