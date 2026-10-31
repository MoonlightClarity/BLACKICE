import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveCodexCommand} from '../lib/codex-discovery.mjs';

test('existing app-local Codex CLI is discovered without modifying global PATH',()=>{
 const env={LOCALAPPDATA:'C:\\Users\\tester\\AppData\\Local'};
 const native=path.win32.join(env.LOCALAPPDATA,'AgentDesk','codex-cli','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
 const calls=[];
 assert.equal(resolveCodexCommand({platform:'win32',arch:'x64',env,exists:filepath=>{calls.push(filepath);return filepath===native;}}),native);
 assert.deepEqual(calls,[native]);
 assert.equal(resolveCodexCommand({platform:'win32',arch:'x64',env,exists:()=>false,execFile:()=>''}),'codex');
});
test('explicit command and CODEX_BINARY override discovery; other platforms use PATH',()=>{
 assert.equal(resolveCodexCommand({command:'C:\\Tools\\codex.exe',env:{CODEX_BINARY:'another'},platform:'win32',exists:()=>true}),'C:\\Tools\\codex.exe');
 assert.equal(resolveCodexCommand({env:{CODEX_BINARY:'C:\\User\\chosen.exe'},platform:'win32',exists:()=>true}),'C:\\User\\chosen.exe');
 assert.equal(resolveCodexCommand({env:{},platform:'linux',exists:()=>true}),'codex');
 assert.equal(resolveCodexCommand({env:{LOCALAPPDATA:'C:\\app'},platform:'win32',arch:'ia32',exists:()=>true}),'codex');
});
test('Windows ARM64 resolves only its matching native package',()=>{
 const env={LOCALAPPDATA:'D:\\LocalData'};
 const wanted=path.win32.join('D:\\LocalData','AgentDesk','codex-cli','node_modules','@openai','codex-win32-arm64','vendor','aarch64-pc-windows-msvc','bin','codex.exe');
 assert.equal(resolveCodexCommand({env,platform:'win32',arch:'arm64',exists:p=>p===wanted}),wanted);
});

test('normal Windows launch discovers the registered Codex desktop CLI without a private PATH',()=>{
 const env={LOCALAPPDATA:'C:\\Users\\tester\\AppData\\Local',SystemRoot:'C:\\Windows',Path:'C:\\Windows\\System32'};
 const packageRoot='C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1027.3384.0_x64__package';
 const binary=path.win32.join(packageRoot,'app','resources','codex.exe');
 const before=structuredClone(env),calls=[];
 const result=resolveCodexCommand({platform:'win32',arch:'x64',env,exists:value=>value===binary,
  execFile:(command,args,options)=>{calls.push({command,args,options});return packageRoot+'\r\n';}});
 assert.equal(result,binary);
 assert.equal(calls.length,1);
 assert.equal(calls[0].command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
 assert.match(calls[0].args.at(-1),/Get-AppxPackage -Name OpenAI\.Codex/);
 assert.match(calls[0].args.at(-1),/Sort-Object Version -Descending/);
 assert.equal(calls[0].options.windowsHide,true);
 assert.equal(calls[0].options.timeout,4000);
 assert.deepEqual(env,before);
});

test('a native CLI on PATH retains precedence and skips desktop lookup',()=>{
 const env={LOCALAPPDATA:'C:\\Local',Path:'"D:\\My CLI";C:\\Windows'};
 const wanted=path.win32.join('D:\\My CLI','codex.exe');
 assert.equal(resolveCodexCommand({platform:'win32',arch:'x64',env,exists:value=>value===wanted,
  execFile:()=>{throw Error('Desktop lookup must not run');}}),'codex');
});

test('desktop discovery validates an existing native CLI and safely falls back on query failure',()=>{
 const base={platform:'win32',arch:'x64',env:{LOCALAPPDATA:'C:\\Local'},exists:()=>false};
 for(const execFile of [()=>'',()=> 'relative-package-path\n',()=>{throw Object.assign(Error('Timed out'),{code:'ETIMEDOUT'});},()=> 'C:\\MissingPackage\n'])
  assert.equal(resolveCodexCommand({...base,execFile}),'codex');
 const packageRoot='D:\\Apps\\Codex ARM64',binary=path.win32.join(packageRoot,'app','resources','codex.exe');
 assert.equal(resolveCodexCommand({...base,arch:'arm64',exists:value=>value===binary,execFile:()=>packageRoot}),binary);
});
