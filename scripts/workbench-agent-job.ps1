# Fixed guest-only supervisor. The host stages this file, body.ps1, job.json
# and a renewable lease in one private agent-jobs/<jobId> directory.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$GuardSource=@'
function Read-JobJson([string]$File,[int]$Limit=8192){
  $item=Get-Item -LiteralPath $File -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Limit){throw 'Unsafe job metadata.'}
  $stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{
    $buffer=New-Object byte[] ($Limit+1);$used=0
    while($used -le $Limit){$count=$stream.Read($buffer,$used,$buffer.Length-$used);if(!$count){break};$used+=$count}
    if($used -gt $Limit){throw 'Oversized job metadata.'}
  }finally{$stream.Dispose()}
  # Release the SMB file handle before decoding or PowerShell parser/JIT work.
  # The bounded byte snapshot is complete; parsing must not block host replace.
  $value=[Text.UTF8Encoding]::new($false,$true).GetString($buffer,0,$used)|ConvertFrom-Json -ErrorAction Stop
  if($value -isnot [pscustomobject]){throw 'Invalid job metadata.'};return $value
}
function Job-Time($Value){
  $parsed=[datetimeoffset]::MinValue
  if($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$' -or
    ![datetimeoffset]::TryParse($Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)){throw 'Invalid job deadline.'}
  return $parsed.UtcDateTime
}
function Job-Number($Value){return $null -ne $Value -and [Type]::GetTypeCode($Value.GetType()) -in @([TypeCode]::Int32,[TypeCode]::Int64,[TypeCode]::Double,[TypeCode]::Decimal)}
function Assert-JobTimeout($Value){if(!(Job-Number $Value) -or [double]$Value -lt 1000 -or [double]$Value -gt 120000 -or [double]$Value -ne [math]::Floor([double]$Value)){throw 'Invalid guest job timeout.'}}
function Assert-JobClockOffset($Value){
  if(!(Job-Number $Value) -or [double]$Value -lt -5000 -or [double]$Value -ge 20000 -or [double]$Value -ne [math]::Floor([double]$Value)){throw 'Invalid paired guest clock binding.'}
}
function Job-HostTime($Value,$Offset){
  Assert-JobClockOffset $Offset
  # This offset is captured by the host from the exact fresh paired heartbeat.
  # Heartbeat transport age only shortens the lease and deadline conservatively.
  return (Job-Time $Value).AddMilliseconds(-[double]$Offset)
}
function Assert-JobBody([string]$Folder,[string]$Expected){
  $file=Join-Path $Folder 'body.ps1';$item=Get-Item -LiteralPath $file -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 524288){throw 'The guest script bytes changed.'}
  $stream=[IO.File]::OpenRead($file);$hash=[Security.Cryptography.SHA256]::Create()
  try{
    $buffer=New-Object byte[] 32768;$total=0
    while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$count;if($total -gt 524288){throw 'The guest script exceeds its bound.'};[void]$hash.TransformBlock($buffer,0,$count,$buffer,0)}
    [void]$hash.TransformFinalBlock([byte[]]@(),0,0);$actual=[BitConverter]::ToString($hash.Hash).Replace('-','').ToLowerInvariant()
  }finally{$stream.Dispose();$hash.Dispose()}
  if($actual -cne $Expected){throw 'The guest script bytes changed.'}
}
function Job-MonotonicMs(){return [Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency}
function Assert-JobAgent($Context){
  $state=$null;$Context.AgentMetadataFailure=$null
  $retryUntil=(Job-MonotonicMs)+1000
  if($Context.AgentFreshUntilMonotonicMs){$retryUntil=[math]::Min($retryUntil,[double]$Context.AgentFreshUntilMonotonicMs)}
  while($true){
    try{$state=Read-JobJson (Join-Path $Context.Bridge 'agent-state.json') 32000;break}
    catch{
      $retryable=$_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
      for($exception=$_.Exception;$exception;$exception=$exception.InnerException){
        $nativeCode=([int64]$exception.HResult -band 65535)
        if($exception -is [IO.FileNotFoundException] -or $exception -is [IO.DirectoryNotFoundException] -or $exception -is [UnauthorizedAccessException] -or
          ($exception -is [IO.IOException] -and $nativeCode -in @(32,33,303))){$retryable=$true;break}
      }
      $remaining=$retryUntil-(Job-MonotonicMs)
      if(!$retryable -or $remaining -le 0){
        $Context.AgentMetadataFailure=if(!$retryable){'invalid_metadata'}elseif($Context.AgentFreshUntilMonotonicMs -and (Job-MonotonicMs) -ge $Context.AgentFreshUntilMonotonicMs){'freshness_exhausted'}else{'transport_exhausted'}
        # PowerShell's child stderr renders ErrorDetails, while the parent catch
        # also retains this phase. Keep the original exception type and line.
        $_.ErrorDetails=[Management.Automation.ErrorDetails]::new(('Agent-state metadata ['+$Context.AgentMetadataFailure+']: '+$_.Exception.Message))
        throw $_
      }
      if($Context.Deadline -and [datetime]::UtcNow -ge $Context.Deadline){$Context.AgentMetadataFailure='deadline_elapsed';throw 'Agent-state metadata read stopped because the guest deadline elapsed.'}
      if(!(Test-JobLease $Context)){$Context.AgentMetadataFailure='authorization_ended';throw 'Agent-state metadata read stopped because current guest authorization ended.'}
      # The guest agent replaces this metadata file. Retry only its
      # brief missing/access/sharing gap, never malformed or valid changed
      # identities. A monotonic one-second budget is shortened by the last
      # verified heartbeat's freshness; live lease/cancellation is checked every
      # wait. Cached identity is never returned or accepted after a read error.
      Start-Sleep -Milliseconds ([int][math]::Min(25,[math]::Ceiling($remaining)))
    }
  }
  $age=([datetime]::UtcNow-(Job-Time $state.heartbeatAt)).TotalMilliseconds
  if(!(Job-Number $state.version) -or $state.version -ne 1 -or $state.agentId -cne $Context.Meta.agentId -or !(Job-Number $state.sessionId) -or
    [double]$state.sessionId -ne $Context.Meta.guestSessionId -or $state.interactive -ne $true -or $age -lt -5000 -or $age -ge 20000 -or
    $state.guestRoot -isnot [string] -or ![IO.Path]::GetFullPath($state.guestRoot).TrimEnd('\').Equals($Context.Workspace.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){
    $Context.AgentMetadataFailure='identity_or_freshness'
    throw 'Agent-state metadata no longer matches the exact paired identity and freshness.'
  }
  $Context.AgentFreshUntilMonotonicMs=(Job-MonotonicMs)+[math]::Min(20000,20000-$age)
}
function Get-JobScope([string]$Folder){
  if(![IO.Path]::IsPathRooted($Folder)){throw 'An absolute guest job directory is required.'}
  $folder=[IO.Path]::GetFullPath($Folder);$jobs=Split-Path $folder -Parent;$bridge=Split-Path $jobs -Parent;$workspace=Split-Path $bridge -Parent
  if((Split-Path $jobs -Leaf) -cne 'agent-jobs' -or (Split-Path $bridge -Leaf) -cne '.blackice-workbench' -or
    (Split-Path $folder -Leaf) -notmatch '^[a-f0-9]{32}$'){throw 'Invalid private guest job path.'}
  for($cursor=$folder;$cursor;){
    $item=Get-Item -LiteralPath $cursor -ErrorAction Stop
    if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Guest job directories must be ordinary folders.'}
    $parent=Split-Path $cursor -Parent;if(!$parent -or $parent -eq $cursor){break};$cursor=$parent
  }
  $meta=Read-JobJson (Join-Path $folder 'job.json')
  $keys=@('version','jobId','scriptSha256','hostName','guestName','guestSessionId','agentId','deadlineAt','scopeHash','workspaceGuestRoot','ownerRevision','timeoutMs','hostToGuestOffsetMs')
  if(@($meta.PSObject.Properties|Where-Object {$_.Name -notin $keys}).Count -or !(Job-Number $meta.version) -or $meta.version -ne 1 -or
    $meta.jobId -isnot [string] -or $meta.jobId -cne (Split-Path $folder -Leaf) -or
    $meta.scriptSha256 -isnot [string] -or $meta.scriptSha256 -notmatch '^[a-f0-9]{64}$' -or
    $meta.scopeHash -isnot [string] -or $meta.scopeHash -notmatch '^[a-f0-9]{64}$' -or
    $meta.agentId -isnot [string] -or $meta.agentId -notmatch '^[a-f0-9]{32}$' -or
    $meta.hostName -isnot [string] -or $meta.hostName -notmatch '^[A-Za-z0-9_-]{1,80}$' -or
    $meta.guestName -isnot [string] -or $meta.guestName -notmatch '^[A-Za-z0-9_-]{1,80}$' -or
    !(Job-Number $meta.guestSessionId) -or [double]$meta.guestSessionId -lt 1 -or [double]$meta.guestSessionId -ne [math]::Floor([double]$meta.guestSessionId) -or
    $meta.workspaceGuestRoot -isnot [string] -or ![IO.Path]::IsPathRooted($meta.workspaceGuestRoot) -or
    ![IO.Path]::GetFullPath($meta.workspaceGuestRoot).TrimEnd('\').Equals($workspace.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){
    throw 'The private guest job identity is invalid.'
  }
  $hostInfo=Read-JobJson (Join-Path $bridge 'host-info.json') 16384
  $actualComputer=[Environment]::MachineName
  $actualSession=[Diagnostics.Process]::GetCurrentProcess().SessionId
  if(!(Job-Number $hostInfo.version) -or $hostInfo.version -ne 1 -or $hostInfo.hostName -isnot [string] -or
    !$hostInfo.hostName.Equals($meta.hostName,[StringComparison]::OrdinalIgnoreCase) -or
    $actualComputer.Equals($meta.hostName,[StringComparison]::OrdinalIgnoreCase) -or
    !$actualComputer.Equals($meta.guestName,[StringComparison]::OrdinalIgnoreCase) -or
    ![Environment]::UserInteractive -or $actualSession -le 0 -or $actualSession -ne $meta.guestSessionId){
    throw 'Refusing to execute outside the exact interactive Windows guest.'
  }
  return @{Folder=$folder;Bridge=$bridge;Workspace=$workspace;Meta=$meta}
}
function Get-JobContext([string]$Folder){
  $context=Get-JobScope $Folder;$meta=$context.Meta
  Assert-JobTimeout $meta.timeoutMs;Assert-JobClockOffset $meta.hostToGuestOffsetMs
  $deadline=Job-HostTime $meta.deadlineAt $meta.hostToGuestOffsetMs
  if(($deadline-[datetime]::UtcNow).TotalMilliseconds -gt 120000){throw 'Guest job deadline exceeds two minutes.'}
  $context.Deadline=$deadline
  Assert-JobAgent $context;Assert-JobBody $folder $meta.scriptSha256;return $context
}
function Test-JobLease($Context){
  $Context.LeaseFailure='lease_unavailable'
  if([IO.File]::Exists((Join-Path $Context.Folder 'cancel.json'))){$Context.LeaseFailure='caller_cancelled';return $false}
  try{
    $lease=Read-JobJson (Join-Path $Context.Folder 'lease.json') 2048
    $Context.LeaseFailure='lease_invalid'
    if(@($lease.PSObject.Properties|Where-Object {$_.Name -notin @('version','jobId','scopeHash','expiresAt')}).Count -or
      !(Job-Number $lease.version) -or $lease.version -ne 1 -or $lease.jobId -cne $Context.Meta.jobId -or $lease.scopeHash -cne $Context.Meta.scopeHash){return $false}
    $remaining=((Job-HostTime $lease.expiresAt $Context.Meta.hostToGuestOffsetMs)-[datetime]::UtcNow).TotalMilliseconds
    if($remaining -le 0){$Context.LeaseFailure='lease_expired';return $false}
    if($remaining -gt 1500){return $false}
    $Context.LeaseFailure=$null
    return $remaining -gt 0 -and $remaining -le 1500
  }catch{return $false}
}
'@
. ([scriptblock]::Create($GuardSource))
# Independent host/guest/session and private-path scope must be proven before
# any diagnostic write. Heartbeat/body/deadline failures are reported only after
# this supervisor obtains its unique claim; no child or Add-Type precedes it.
$context=Get-JobScope $PSScriptRoot
$ObservationSource=@'
function Convert-BLACKICEObservationValue($Value,[int]$Depth=0){
  if($Depth -gt 8){throw 'Observation nesting exceeds eight levels. Select fewer primitive fields.'}
  if($null -eq $Value){return $null}
  $base=$Value.PSObject.BaseObject
  if($base -is [string]){return [string]::new(([string]$base).ToCharArray())}
  if($base -is [bool]){return [bool]$base}
  if($base -is [datetime]){return $base.ToUniversalTime().ToString('o')}
  if($base -is [datetimeoffset]){return $base.UtcDateTime.ToString('o')}
  if($base -is [guid]){return $base.ToString('D')}
  if([Type]::GetTypeCode($base.GetType()) -in @([TypeCode]::Byte,[TypeCode]::SByte,[TypeCode]::Int16,[TypeCode]::UInt16,[TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64,[TypeCode]::Single,[TypeCode]::Double,[TypeCode]::Decimal)){
    if([double]::IsNaN([double]$base) -or [double]::IsInfinity([double]$base) -or
      (($base -is [decimal]) -and [math]::Abs([decimal]$base) -gt [decimal]'9007199254740991') -or
      [math]::Abs([double]$base) -gt 9007199254740991){throw 'Observation numbers must be finite and within the JSON safe numeric range. Format larger values explicitly as strings.'}
    return $base
  }
  if($base -is [Collections.IDictionary]){
    $map=[ordered]@{}
    foreach($key in $base.Keys){
      if($key -isnot [string]){throw 'Observation object keys must be strings.'}
      if($map.Contains($key)){throw 'Observation object keys must not collide by case.'}
      $map[$key]=Convert-BLACKICEObservationValue $base[$key] ($Depth+1)
    }
    return $map
  }
  if($base -is [Collections.IEnumerable]){
    $list=[Collections.Generic.List[object]]::new()
    foreach($item in $base){$list.Add((Convert-BLACKICEObservationValue $item ($Depth+1)))}
    return ,$list.ToArray()
  }
  if($Value -is [pscustomobject]){
    $map=[ordered]@{}
    foreach($property in $Value.PSObject.Properties){
      if($property.MemberType -ne [Management.Automation.PSMemberTypes]::NoteProperty){throw 'Select explicit data properties before serializing an observation.'}
      if($map.Contains($property.Name)){throw 'Observation object keys must not collide by case.'}
      $map[$property.Name]=Convert-BLACKICEObservationValue $property.Value ($Depth+1)
    }
    return $map
  }
  throw 'Observation contains a non-data object. Select named primitive fields first.'
}
function Write-BLACKICEObservation {
  param([Parameter(Mandatory=$true)]$Data)
  if($Data -isnot [Collections.IDictionary] -and $Data -isnot [pscustomobject]){throw 'A structured observation must have one object at its root.'}
  $normalized=Convert-BLACKICEObservationValue $Data
  $json=ConvertTo-Json -InputObject $normalized -Compress -Depth 10
  if([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384){throw 'Observation exceeds 16384 UTF-8 bytes. Query fewer named fields; no partial JSON was emitted.'}
  [Console]::Write($json)
}
'@
$JsonCompatibilitySource=@'
function Remove-BLACKICEJsonProviderMetadata($Value,$Records){
  $queue=[Collections.Generic.Stack[object]]::new()
  $queue.Push([pscustomobject]@{Value=$Value})
  $seen=[Runtime.Serialization.ObjectIDGenerator]::new()
  while($queue.Count){
    $item=$queue.Pop().Value
    if($null -eq $item){continue}
    $base=$item.PSObject.BaseObject
    if($base -is [string]){
      $provider=$item.PSObject.Properties['PSProvider']
      if($provider -and $provider.MemberType -eq [Management.Automation.PSMemberTypes]::NoteProperty -and $provider.Value -is [Management.Automation.ProviderInfo]){
        $target=$item.PSObject
        foreach($name in @('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider','ReadCount')){
          $property=$target.Properties[$name]
          if($property -and $property.MemberType -eq [Management.Automation.PSMemberTypes]::NoteProperty){
            $Records.Add(@{Target=$target;Property=$property.Copy()})
            $target.Properties.Remove($name)
          }
        }
      }
      continue
    }
    $first=$false
    $null=$seen.GetId($base,[ref]$first)
    if(!$first){continue}
    if($base -is [Collections.IDictionary]){
      foreach($next in $base.Values){$queue.Push([pscustomobject]@{Value=$next})}
    }elseif($base -is [Array]){
      foreach($next in $base){$queue.Push([pscustomobject]@{Value=$next})}
    }elseif($base -is [Management.Automation.PSCustomObject]){
      foreach($property in $item.PSObject.Properties){
        if($property.MemberType -eq [Management.Automation.PSMemberTypes]::NoteProperty){$queue.Push([pscustomobject]@{Value=$property.Value})}
      }
    }
  }
}
function Restore-BLACKICEJsonProviderMetadata($Records){
  foreach($record in $Records){$record.Target.Properties.Add($record.Property)}
}
# Windows PowerShell 5 serializes Get-Content's string provider notes as data,
# including its complete PSDrive. Keep that implementation detail out of JSON.
# This session-local proxy preserves native input/parameter binding and invokes
# the original module-qualified cmdlet. Provider notes remain available outside
# serialization; non-provider/custom string properties and all other data stay.
function ConvertTo-Json {
  [CmdletBinding(HelpUri='https://go.microsoft.com/fwlink/?LinkID=217032',RemotingCapability='None')]
  param(
    [Parameter(Mandatory=$true,Position=0,ValueFromPipeline=$true)]
    [AllowNull()][object]$InputObject,
    [ValidateRange(1,2147483647)][int]$Depth,
    [switch]$Compress
  )
  begin {$jsonInputs=[Collections.Generic.List[object]]::new()}
  process {$jsonInputs.Add([pscustomobject]@{Value=$InputObject})}
  end {
    if(!$jsonInputs.Count){return}
    if($jsonInputs.Count -eq 1){$data=$jsonInputs[0].Value}
    else{
      $data=[object[]]::new($jsonInputs.Count)
      for($index=0;$index -lt $jsonInputs.Count;$index++){$data[$index]=$jsonInputs[$index].Value}
    }
    $parameters=@{}
    foreach($key in $PSBoundParameters.Keys){if($key -ne 'InputObject'){$parameters[$key]=$PSBoundParameters[$key]}}
    $providerMetadata=[Collections.Generic.List[object]]::new()
    try{
      Remove-BLACKICEJsonProviderMetadata $data $providerMetadata
      $json=Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $data @parameters
    }finally{
      Restore-BLACKICEJsonProviderMetadata $providerMetadata
    }
    # Restore before publishing even to a downstream pipeline consumer.
    $json
  }
}
'@
$NativeSource=@'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class BLACKICEAgentOutput {
 public readonly string Text;public readonly bool Truncated;public readonly long CharactersRead;
 public BLACKICEAgentOutput(string text,bool truncated,long charactersRead){Text=text;Truncated=truncated;CharactersRead=charactersRead;}
}
public sealed class BLACKICEAgentJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long perProcess,perJob;public uint flags;public UIntPtr minimum,maximum;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct Limits {public BasicLimits basic;public IoCounters io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [StructLayout(LayoutKind.Sequential)] struct Accounting {public long user,kernel,periodUser,periodKernel;public uint faults,total,active,terminated;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateJobObject(IntPtr job,uint exitCode);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 sealed class OutputCapture {public readonly StringBuilder Text=new StringBuilder();public bool Overflow;public long CharactersRead;}
 IntPtr job;Process child;Task outputTask,errorTask;bool assigned,started;readonly OutputCapture output=new OutputCapture(),error=new OutputCapture();
 public BLACKICEAgentJob(){job=CreateJobObjectW(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new InvalidOperationException("Process job creation failed.");var limits=new Limits();limits.basic.flags=0x2000;if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits)))){CloseHandle(job);job=IntPtr.Zero;throw new InvalidOperationException("Process job limits failed.");}}
 static void Drain(System.IO.TextReader reader,OutputCapture capture){char[] buffer=new char[1024];for(int count;(count=reader.Read(buffer,0,buffer.Length))>0;){lock(capture){capture.CharactersRead+=count;int keep=Math.Min(count,16384-capture.Text.Length);if(keep>0)capture.Text.Append(buffer,0,keep);if(keep<count)capture.Overflow=true;}}}
 public static string BoundOutput(string text){string value=text??"";if(value.Length>0&&char.IsHighSurrogate(value[value.Length-1]))value=value.Substring(0,value.Length-1);byte[] bytes=Encoding.UTF8.GetBytes(value);if(bytes.Length<=16384)return value;int size=16384;var strict=new UTF8Encoding(false,true);for(int i=0;i<4;i++,size--)try{return strict.GetString(bytes,0,size);}catch(DecoderFallbackException){}return "Output exceeded its bound.";}
 static BLACKICEAgentOutput Snapshot(OutputCapture capture){lock(capture){string raw=capture.Text.ToString(),bounded=BoundOutput(raw);return new BLACKICEAgentOutput(bounded,capture.Overflow||!String.Equals(raw,bounded,StringComparison.Ordinal),capture.CharactersRead);}}
 // The same stream drain is testable without constructing a process/job or
 // mutating a desktop. Completion and output completeness are distinct facts.
 public static BLACKICEAgentOutput ReadOutput(System.IO.TextReader reader){var capture=new OutputCapture();Drain(reader,capture);return Snapshot(capture);}
 public void Start(string executable,string script,string directory){
  if(child!=null)throw new InvalidOperationException("A child already exists.");
  var start=new ProcessStartInfo(executable,"-NoProfile -NonInteractive -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File \""+script.Replace("\"","")+"\"");
  start.WorkingDirectory=directory;start.UseShellExecute=false;start.CreateNoWindow=true;start.WindowStyle=ProcessWindowStyle.Hidden;
  start.RedirectStandardOutput=true;start.RedirectStandardError=true;start.StandardOutputEncoding=new UTF8Encoding(false);start.StandardErrorEncoding=new UTF8Encoding(false);
  child=new Process();child.StartInfo=start;if(!child.Start())throw new InvalidOperationException("Guest child did not start.");started=true;
  outputTask=Task.Run(()=>Drain(child.StandardOutput,output));errorTask=Task.Run(()=>Drain(child.StandardError,error));
  if(!AssignProcessToJobObject(job,child.Handle))throw new InvalidOperationException("Guest child was not assigned to its process job.");assigned=true;
 }
 public bool HasExited {get{return started&&child!=null&&child.HasExited;}}
 public int ExitCode {get{return started&&child!=null&&child.HasExited?child.ExitCode:-1;}}
 public bool OutputComplete {get{return outputTask!=null&&errorTask!=null&&outputTask.Status==TaskStatus.RanToCompletion&&errorTask.Status==TaskStatus.RanToCompletion;}}
 public string Stdout {get{return Snapshot(output).Text;}}
 public string Stderr {get{return Snapshot(error).Text;}}
 public bool StdoutTruncated {get{return Snapshot(output).Truncated;}}
 public bool StderrTruncated {get{return Snapshot(error).Truncated;}}
 public bool StopAndWait(int timeoutMilliseconds){
  try{
   if(assigned){if(!TerminateJobObject(job,1))return false;}else if(started&&child!=null&&!child.HasExited)child.Kill();
   var timer=Stopwatch.StartNew();
   while(timer.ElapsedMilliseconds<timeoutMilliseconds){
    Accounting info;if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))return false;
    if(info.active==0&&(!started||child==null||child.HasExited)){
     if(outputTask!=null&&errorTask!=null)Task.WaitAll(new[]{outputTask,errorTask},1000);return true;
    }Thread.Sleep(20);
   }
  }catch{}return false;
 }
 public void Dispose(){if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}if(child!=null)child.Dispose();}
}
'@
$job=$null;$status='failed';$exitCode=-1;$stdout='';$stderr='';$stdoutTruncated=$false;$stderrTruncated=$false;$outputDrained=$false;$childrenStopped=$false;$stage='claim';$terminationReason='supervisor_error';$ownsClaim=$false;$diagnostic=$null
try{
  foreach($name in @('child.ps1','go.json','result.json')){if(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name)){throw 'This job already has an execution attempt. Inspect its existing receipt.'}}
  # A losing or restarted supervisor cannot publish a false terminal receipt
  # while the original supervisor still owns a running child.
  $claim=[IO.File]::Open((Join-Path $PSScriptRoot 'supervisor.claim.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$ownsClaim=$true
  try{$claimBytes=[Text.UTF8Encoding]::new($false).GetBytes((@{version=1;jobId=$context.Meta.jobId;scopeHash=$context.Meta.scopeHash;pid=$PID}|ConvertTo-Json -Compress));$claim.Write($claimBytes,0,$claimBytes.Length);$claim.Flush($true)}finally{$claim.Dispose()}
  $stage='preflight'
  $context=Get-JobContext $PSScriptRoot
  $budget=[Diagnostics.Stopwatch]::StartNew();$budgetMs=[math]::Max(0,[math]::Min([double]$context.Meta.timeoutMs,($context.Deadline-[datetime]::UtcNow).TotalMilliseconds))
  $stage='lease_check'
  if([datetime]::UtcNow -ge $context.Deadline){$status='timed_out';$terminationReason='deadline_elapsed';throw 'The guest job deadline expired before launch.'}
  if(!(Test-JobLease $context)){$status='cancelled';$terminationReason=$context.LeaseFailure;throw 'The guest job lease is absent or expired.'}
  $stage='compile'
  Add-Type -TypeDefinition $NativeSource
  $job=[BLACKICEAgentJob]::new()
  $stage='child_prepare'
  $childSource='$ErrorActionPreference=''Stop'';$ProgressPreference=''SilentlyContinue'';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)'+"`r`n"+$GuardSource+"`r`n"+$ObservationSource+"`r`n"+$JsonCompatibilitySource+@'

$context=Get-JobContext $PSScriptRoot
$go=Join-Path $PSScriptRoot 'go.json'
while(![IO.File]::Exists($go)){
  if([datetime]::UtcNow -ge $context.Deadline -or !(Test-JobLease $context)){exit 124}
  Start-Sleep -Milliseconds 25
}
$gate=Read-JobJson $go 2048
if(!(Job-Number $gate.version) -or $gate.version -ne 1 -or $gate.jobId -cne $context.Meta.jobId -or $gate.scriptSha256 -cne $context.Meta.scriptSha256 -or
  $gate.scopeHash -cne $context.Meta.scopeHash -or [datetime]::UtcNow -ge $context.Deadline -or !(Test-JobLease $context)){exit 125}
Assert-JobAgent $context;Assert-JobBody $PSScriptRoot $context.Meta.scriptSha256
if([datetime]::UtcNow -ge $context.Deadline -or !(Test-JobLease $context)){exit 126}
& (Join-Path $PSScriptRoot 'body.ps1')
if(!$?){exit 1}
'@
  $childFile=Join-Path $PSScriptRoot 'child.ps1';$file=[IO.File]::Open($childFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($childSource);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  $shell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $stage='child_start'
  $job.Start($shell,$childFile,$PSScriptRoot)
  $stage='start_gate'
  Assert-JobAgent $context;Assert-JobBody $PSScriptRoot $context.Meta.scriptSha256
  if([datetime]::UtcNow -ge $context.Deadline -or $budget.ElapsedMilliseconds -ge $budgetMs){$status='timed_out';$terminationReason='deadline_elapsed';throw 'The guest job expired before its start gate.'}
  if(!(Test-JobLease $context)){$status='cancelled';$terminationReason=$context.LeaseFailure;throw 'The guest job was cancelled before its start gate.'}
  $gate=@{version=1;jobId=$context.Meta.jobId;scriptSha256=$context.Meta.scriptSha256;scopeHash=$context.Meta.scopeHash}|ConvertTo-Json -Compress
  $goFile=Join-Path $PSScriptRoot 'go.json';$goTemporary=$goFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  $file=[IO.File]::Open($goTemporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($gate);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  try{[IO.File]::Move($goTemporary,$goFile)}finally{if([IO.File]::Exists($goTemporary)){[IO.File]::Delete($goTemporary)}}
  $stage='script'
  $lastAgentCheck=[datetime]::MinValue
  while(!$job.HasExited){
    if([datetime]::UtcNow -ge $context.Deadline -or $budget.ElapsedMilliseconds -ge $budgetMs){$status='timed_out';$terminationReason='deadline_elapsed';break}
    if(!(Test-JobLease $context)){$status='cancelled';$terminationReason=$context.LeaseFailure;break}
    if(([datetime]::UtcNow-$lastAgentCheck).TotalMilliseconds -ge 250){Assert-JobAgent $context;$lastAgentCheck=[datetime]::UtcNow}
    Start-Sleep -Milliseconds 50
  }
  if($job.HasExited){$exitCode=$job.ExitCode;$terminationReason='script_exit';$status=if($exitCode -eq 0){'completed'}else{'failed'}}
}catch{
  $stderr='The guest script job could not be confirmed.'
  $errorType=$_.Exception.GetType().FullName;$message=[string]$_.Exception.Message
  if($context.AgentMetadataFailure){$message='Agent-state metadata ['+$context.AgentMetadataFailure+']: '+$message}
  if($errorType.Length -gt 160){$errorType=$errorType.Substring(0,160)}
  if($message.Length -gt 2048){$message=$message.Substring(0,2048)}
  $diagnostic=@{errorType=$errorType;line=[int]$_.InvocationInfo.ScriptLineNumber;message=($message -replace '[\x00-\x08\x0b\x0c\x0e-\x1f]',' ')}
}finally{
  if(!$ownsClaim){
    # Scope is proven, but another supervisor may own a child. This is an
    # observation only: it carries no terminal state or termination assertion.
    if($diagnostic){
      $early=@{version=1;jobId=$context.Meta.jobId;scopeHash=$context.Meta.scopeHash;stage=$stage;diagnostic=$diagnostic;observedAt=[datetime]::UtcNow.ToString('o')}
      $earlyPath=Join-Path $PSScriptRoot ('preflight-diagnostic-'+$PID+'.json')
      [IO.File]::WriteAllText($earlyPath,($early|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
    }
  }else{
  if($job){
    $childrenStopped=$job.StopAndWait(3000)
    if($job.HasExited){$exitCode=$job.ExitCode}
    # Sample completion before reading output: a drain that finishes between
    # reads must never promote an earlier partial snapshot to complete evidence.
    $outputDrained=$job.OutputComplete
    $stdout=$job.Stdout;$capturedError=$job.Stderr;if($capturedError){$stderr=$capturedError}
    $stdoutTruncated=$job.StdoutTruncated;$stderrTruncated=$job.StderrTruncated
    if(!$outputDrained -and $status -eq 'completed'){$status='failed';$stage='cleanup';$terminationReason='output_unconfirmed';$stderr='Guest output completion could not be confirmed.'}
    $job.Dispose()
  }else{$childrenStopped=$true}
  if(!$childrenStopped){$status='failed';$stage='cleanup';$terminationReason='termination_unconfirmed';$stderr='Guest process-tree termination could not be confirmed.'}
  $record=[ordered]@{version=1;jobId=$context.Meta.jobId;scriptSha256=$context.Meta.scriptSha256;scopeHash=$context.Meta.scopeHash;
    agentId=$context.Meta.agentId;guestSessionId=$context.Meta.guestSessionId;status=$status;exitCode=$exitCode;
    stdout=$stdout;stderr=$stderr;stdoutTruncated=$stdoutTruncated;stderrTruncated=$stderrTruncated;outputDrained=$outputDrained;childrenStopped=$childrenStopped;stage=$stage;terminationReason=$terminationReason;finishedAt=[datetime]::UtcNow.ToString('o')}
  if($diagnostic){$record['diagnostic']=$diagnostic}
  $result=Join-Path $PSScriptRoot 'result.json';$temporary=$result+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  $file=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Depth 5 -Compress));$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  try{[IO.File]::Move($temporary,$result)}finally{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
  }
}
