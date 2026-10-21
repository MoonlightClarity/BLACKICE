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
 assert.equal(resolveCodexCommand({platform:'win32',arch:'x64',env,exists:()=>false}),'codex');
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
