import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixture = fileURLToPath(new URL('../verification/workbench-native-motion-fixture.ps1', import.meta.url));

test('guest motion fixture guards the host before loading UI or writing metadata', async () => {
  const source = await fs.readFile(fixture, 'utf8'), ui = source.indexOf('Add-Type -AssemblyName');
  for (const guard of ['host-info.json', 'Host execution refused', 'Win32_ComputerSystem', 'interactive guest session', 'ApartmentState]::STA']) {
    assert.ok(source.indexOf(guard) > 0 && source.indexOf(guard) < ui, guard);
  }
  assert.match(source, /ValidateRange\(20,30\)/);
  assert.match(source, /ValidateRange\(8,100\)\]\[int\]\$FrameIntervalMilliseconds=33/);
  assert.match(source, /new DeadlinePacer\(frameIntervalMilliseconds,/);
  assert.match(source, /SlotForElapsed\(now,frameIntervalMilliseconds\)/);
  assert.match(source, /requestedIntervalMs=frameIntervalMilliseconds,targetFramesPerSecond=1000\.0\/frameIntervalMilliseconds/);
  assert.match(source, /return Run\(runId,outputPath,host,seconds,session,33\)/);
  assert.match(source, /\$guestSessionId,\$FrameIntervalMilliseconds\)/);
  assert.match(source, /elapsed\.Elapsed\.TotalSeconds>=duration.*Close\(\)/);
  assert.match(source, /clockDomain="guest Stopwatch"/);
  assert.match(source, /guestSessionId=guestSession/);
  assert.match(source, /clientBounds=Rect\(marker\.Bounds\),screenBounds=Rect\(screen\)/);
  assert.match(source, /CounterBits=32, CounterCellWidth=8, CounterCellHeight=12/);
  assert.match(source, /new object\[MotionCanvas\.CounterBits\*2\]/);
  assert.match(source, /CounterY\+CounterCellHeight,CounterCellWidth,CounterCellHeight/);
  assert.match(source, /algorithm="crc32-ieee",inputEncoding="uint32-little-endian",bits=32,pointOffset=32/);
  assert.match(source, /bitOrder="least-significant-first",valueType="uint32"/);
  assert.match(source, /lastPaintedValue=unchecked\(\(uint\)canvas\.LastPaintFrame\)/);
  assert.match(source, /screenPoint=new \{x=screen\.X,y=screen\.Y\}/);
  assert.match(source, /binaryFrameCounter=BinaryCounterInfo\(\)/);
  assert.match(source, /MoveFileExW\(temporary,target,1u\|8u\)/);
  assert.doesNotMatch(source, /File\.Replace\(/);
  assert.match(source, /finalMetadataPath=writer\.FinalDestination/);
  assert.doesNotMatch(source, /SendKeys|SendInput|SetForegroundWindow|Process\.Start|Start-Process|Stop-Process|Restart-Computer|Stop-Computer|RunAs|Set-ItemProperty/);
});

test('guest fixture compiles and its writer/final fallback/deadline scheduler work without launching a window', { skip: process.platform !== 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'blackice-motion-compile-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const validator = path.join(temp, 'compile.ps1');
  await fs.writeFile(validator, `param([string]$Fixture)
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile($Fixture,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors|Out-String)}
$assignment=$tree.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.VariablePath.UserPath -eq 'fixtureSource'},$true)
if(!$assignment){throw 'Embedded source not found.'}
$source=$assignment.Right.Expression.Value
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions
Add-Type -TypeDefinition ($source+@'
public static class FixtureNoUiChecks {
  static void Wait(System.Func<bool> condition,string message) {
    var watch=System.Diagnostics.Stopwatch.StartNew();
    while(!condition()){if(watch.ElapsedMilliseconds>2500)throw new System.Exception(message);System.Threading.Thread.Sleep(5);}
  }
  public static void Check(string directory) {
    if(Blackice.GuestVerification.FrameIntegrity.CounterCrc32(0u)!=0x2144df1cu||
       Blackice.GuestVerification.FrameIntegrity.CounterCrc32(1u)!=0x99f8b879u||
       Blackice.GuestVerification.FrameIntegrity.CounterCrc32(0x34333231u)!=0x9be3e0a3u||
       Blackice.GuestVerification.FrameIntegrity.CounterCrc32(0x80000000u)!=0xccfc5c3cu||
       Blackice.GuestVerification.FrameIntegrity.CounterCrc32(0xffffffffu)!=0xffffffffu)
      throw new System.Exception("Counter CRC32 differs from independent zlib golden vectors.");
    string destination=System.IO.Path.Combine(directory,"snapshot.json");
    using(var writer=new Blackice.GuestVerification.SnapshotWriter(destination)) {
      writer.Publish("first");Wait(()=>writer.Writes>=1,"First publication failed.");
      writer.Publish("second");Wait(()=>writer.Writes>=2,"Replacement publication failed.");
      if(System.IO.File.ReadAllText(destination)!="second")throw new System.Exception("Rolling metadata is stale.");
      using(var reader=new System.IO.FileStream(destination,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.Read)) {
        writer.Publish("released-lock");System.Threading.Thread.Sleep(60);reader.Dispose();
        Wait(()=>writer.Writes>=3,"A transient reader lock was not retried.");
        if(writer.LastError.Length!=0||System.IO.File.ReadAllText(destination)!="released-lock")
          throw new System.Exception("A successful bounded metadata retry became a fixture failure.");
        if(System.IO.Directory.GetFiles(directory,"snapshot.json.*.tmp").Length!=0)
          throw new System.Exception("A retry left an unsealed or stale temporary file.");
      }
      using(var reader=new System.IO.FileStream(destination,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.Read)) {
        writer.Publish("closed",true);Wait(()=>writer.FinalWritten,"Immutable final publication failed.");
        Wait(()=>writer.LastError.Length>0,"The expected primary sharing failure was not recorded.");
        if(System.IO.File.ReadAllText(writer.FinalDestination)!="closed")throw new System.Exception("Final receipt was lost when replacement failed.");
      }
      writer.Publish("after-exhaustion");Wait(()=>writer.Writes>=4,"Writer did not recover after the exhausted lock released.");
      if(writer.LastError.Length==0)throw new System.Exception("An exhausted metadata failure was silently cleared.");
      writer.Dispose();writer.Dispose();
    }
    if(Blackice.GuestVerification.DeadlinePacer.SlotForElapsed(47,33)!=1||Blackice.GuestVerification.DeadlinePacer.SlotForElapsed(78,33)!=2||
       Blackice.GuestVerification.DeadlinePacer.SlotForElapsed(109,33)!=3||Blackice.GuestVerification.DeadlinePacer.SlotForElapsed(140,33)!=4)
      throw new System.Exception("Frame slots drift with rounded waits.");
    foreach(int period in new int[]{8,16,33,100}) {
      if(Blackice.GuestVerification.MotionFixture.ValidateFrameIntervalMilliseconds(period)!=period||
         Blackice.GuestVerification.DeadlinePacer.SlotForElapsed(period*100+period-0.01,period)!=100)
        throw new System.Exception("Requested frame interval was not preserved.");
    }
    foreach(int invalid in new int[]{0,7,101}) {
      bool rejected=false;try{Blackice.GuestVerification.MotionFixture.ValidateFrameIntervalMilliseconds(invalid);}
      catch(System.ArgumentOutOfRangeException){rejected=true;}
      if(!rejected)throw new System.Exception("Unsafe frame interval accepted.");
    }
    if(typeof(Blackice.GuestVerification.MotionFixture).GetMethod("Run",new System.Type[]{typeof(string),typeof(string),typeof(string),typeof(int),typeof(int)})==null||
       typeof(Blackice.GuestVerification.MotionFixture).GetMethod("Run",new System.Type[]{typeof(string),typeof(string),typeof(string),typeof(int),typeof(int),typeof(int)})==null)
      throw new System.Exception("The original or explicit-cadence Run overload is missing.");
    int count=0;
    using(var clock=new Blackice.GuestVerification.DeadlinePacer(16,()=>System.Threading.Interlocked.Increment(ref count))) {
      clock.Start();Wait(()=>count>=3,"Absolute-deadline scheduler did not run.");clock.Dispose();clock.Dispose();
      int stopped=count;System.Threading.Thread.Sleep(75);if(count!=stopped)throw new System.Exception("Scheduler continued after disposal.");
    }
  }
}
'@) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
if(!('Blackice.GuestVerification.MotionFixture' -as [type])){throw 'Fixture type did not compile.'}
[FixtureNoUiChecks]::Check((Split-Path $MyInvocation.MyCommand.Path -Parent))
Write-Output 'COMPILED_WITHOUT_LAUNCH'
`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', validator, '-Fixture', fixture], {
    windowsHide: true, encoding: 'utf8', timeout: 30000, env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /COMPILED_WITHOUT_LAUNCH/);
});
