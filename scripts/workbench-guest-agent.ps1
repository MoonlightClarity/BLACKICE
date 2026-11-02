# BLACKICE Workbench guest-side agent.
# Run INSIDE the installed Windows guest in a logged-in interactive session:
# powershell.exe -NoProfile -Sta -WindowStyle Hidden -ExecutionPolicy Bypass -File W:\.blackice-workbench\guest-agent.ps1
# The user-configured W: drive must be the authenticated bidirectional SMB share.
# No network listener, host desktop input, shell-script dispatch or host secrets.
param([string]$WorkspaceRoot)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if(-not $WorkspaceRoot){$WorkspaceRoot=Split-Path -Parent $PSScriptRoot}
if(-not [IO.Path]::IsPathRooted($WorkspaceRoot)){throw 'Guest workspace must be an absolute mapped Windows path.'}
$Bridge=Join-Path $WorkspaceRoot '.blackice-workbench'
$HostInfoPath=Join-Path $Bridge 'host-info.json'
if(!(Test-Path -LiteralPath $HostInfoPath)){throw 'Workbench host identity file is missing; prepare the bridge on the host.'}
$HostInfo=Get-Content -LiteralPath $HostInfoPath -Raw|ConvertFrom-Json
if(!$HostInfo.hostName){throw 'Workbench host identity missing.'}
if(([string]$HostInfo.hostName).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Refusing to run the Workbench guest agent on the host Windows desktop.'
}
$Process=[System.Diagnostics.Process]::GetCurrentProcess()
$SessionId=[int]$Process.SessionId
$Interactive=[Environment]::UserInteractive -and $SessionId -gt 0
if(!$Interactive){throw 'A logged-in interactive guest Windows session is required. Background service sessions cannot capture or click the desktop.'}
# Report this independently guarded guest process token, never the host token or
# whether the Windows account merely belongs to the Administrators group.
$GuestPrivileges=$null
try{
  $GuestIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{
    $GuestPrincipal=[Security.Principal.WindowsPrincipal]::new($GuestIdentity)
    $GuestPrivileges=[ordered]@{
      administratorToken=[bool]$GuestPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      basis='interactive-guest-agent-token'
    }
  }finally{if($GuestIdentity){$GuestIdentity.Dispose()}}
}catch{
  # An unreadable token is unknown, not evidence of standard guest privileges.
  $GuestPrivileges=$null
}
$AgentId=[guid]::NewGuid().ToString('N')
$Requests=Join-Path $Bridge 'requests'
$Responses=Join-Path $Bridge 'responses'
$Processing=Join-Path $Bridge 'processing'
$Frames=Join-Path $Bridge 'frames'
$ClipboardExpiry=Join-Path $Bridge 'clipboard-expiry'
foreach($folder in @($Requests,$Responses,$Processing,$Frames,$ClipboardExpiry)){New-Item -ItemType Directory -Path $folder -Force|Out-Null}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BLACKICEGuestJson {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool MoveFileExW(string source,string destination,uint flags);
 static void OrdinaryDirectory(string directory){
  for(var current=new System.IO.DirectoryInfo(directory);current!=null;current=current.Parent){
   var attributes=System.IO.File.GetAttributes(current.FullName);
   if((attributes&System.IO.FileAttributes.Directory)==0||(attributes&System.IO.FileAttributes.ReparsePoint)!=0)
    throw new System.IO.IOException("Guest metadata requires ordinary directories.");
  }
 }
 static void OrdinaryTarget(string file){
  try{
   var attributes=System.IO.File.GetAttributes(file);
   if((attributes&(System.IO.FileAttributes.Directory|System.IO.FileAttributes.ReparsePoint))!=0)
    throw new System.IO.IOException("Guest metadata requires an ordinary file.");
  }catch(System.IO.FileNotFoundException){}
 }
 public static void Publish(string file,string json){
  if(!System.IO.Path.IsPathRooted(file))throw new ArgumentException("An absolute guest metadata path is required.");
  file=System.IO.Path.GetFullPath(file);
  string directory=System.IO.Path.GetDirectoryName(file);
  OrdinaryDirectory(directory);OrdinaryTarget(file);
  byte[] bytes=new System.Text.UTF8Encoding(false,true).GetBytes(json);
  if(bytes.Length>524288)throw new ArgumentException("Guest metadata exceeds its byte bound.");
  string temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
  try{
   using(var stream=new System.IO.FileStream(temporary,System.IO.FileMode.CreateNew,System.IO.FileAccess.Write,System.IO.FileShare.None)){
    stream.Write(bytes,0,bytes.Length);stream.Flush(true);
   }
   var clock=System.Diagnostics.Stopwatch.StartNew();
   while(true){
    OrdinaryDirectory(directory);OrdinaryTarget(file);
    // Same-directory rename replacement, including on SMB. Never use the
    // PowerShell provider's Force fallback (delete destination then move),
    // COPY_ALLOWED, or a delete/recreate fallback: readers retain the last
    // complete heartbeat until the new complete file is published.
    if(MoveFileExW(temporary,file,0x00000001|0x00000008))return;
    int code=Marshal.GetLastWin32Error();
    if((code!=5&&code!=32&&code!=33&&code!=303)||clock.ElapsedMilliseconds>=250)
     throw new System.ComponentModel.Win32Exception(code,"Guest metadata replacement was not confirmed.");
    System.Threading.Thread.Sleep((int)Math.Min(10,Math.Max(1,250-clock.ElapsedMilliseconds)));
   }
  }finally{try{System.IO.File.Delete(temporary);}catch{}}
 }
}
public static class BLACKICEGuestMouse {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint data,UIntPtr extra);
 public static void Click(int x,int y){
   if(!SetCursorPos(x,y)) throw new InvalidOperationException("Guest mouse position could not be set.");
   mouse_event(0x0002,0,0,0,UIntPtr.Zero);
   mouse_event(0x0004,0,0,0,UIntPtr.Zero);
 }
}
public interface IBLACKICEClipboardApi {
 IntPtr CreateOwner(); void DestroyOwner(IntPtr owner);
 bool Open(IntPtr owner); bool Close(); uint Sequence(); uint NextFormat(uint previous); bool HasFormat(uint format);
 IntPtr GetData(uint format); ulong Size(IntPtr memory); IntPtr Lock(IntPtr memory); void Unlock(IntPtr memory);
 IntPtr Allocate(uint bytes); void Free(IntPtr memory); bool Empty(); IntPtr SetData(uint format,IntPtr memory);
}
public sealed class BLACKICEClipboardException : InvalidOperationException {
 public string Code {get;private set;} public bool ClipboardMayHaveChanged {get;private set;}
 public BLACKICEClipboardException(string code,string message,bool changed=false):base(message){Code=code;ClipboardMayHaveChanged=changed;}
}
sealed class BLACKICEClipboardWin32 : IBLACKICEClipboardApi {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWindowExW(uint ex,string cls,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
 [DllImport("user32.dll",SetLastError=true)]static extern bool DestroyWindow(IntPtr window);
 [DllImport("user32.dll",SetLastError=true)]static extern bool OpenClipboard(IntPtr owner);
 [DllImport("user32.dll",SetLastError=true)]static extern bool CloseClipboard();
 [DllImport("user32.dll")]static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetUserObjectInformationW(IntPtr handle,int index,System.Text.StringBuilder information,uint bytes,out uint needed);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenWindowStationW(string name,bool inherit,uint access);
 [DllImport("user32.dll",SetLastError=true)]static extern bool CloseWindowStation(IntPtr station);
 [DllImport("user32.dll",SetLastError=true)]static extern uint EnumClipboardFormats(uint previous);
 [DllImport("user32.dll")]static extern bool IsClipboardFormatAvailable(uint format);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll",SetLastError=true)]static extern bool EmptyClipboard();
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetClipboardData(uint format,IntPtr memory);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr GlobalAlloc(uint flags,UIntPtr bytes);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr GlobalFree(IntPtr memory);
 [DllImport("kernel32.dll",SetLastError=true)]static extern UIntPtr GlobalSize(IntPtr memory);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr GlobalLock(IntPtr memory);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GlobalUnlock(IntPtr memory);
 [DllImport("kernel32.dll")]static extern void SetLastError(uint error);
 public IntPtr CreateOwner(){return CreateWindowExW(0x08000000,"STATIC","",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);}
 public void DestroyOwner(IntPtr owner){if(owner!=IntPtr.Zero)DestroyWindow(owner);}
 public bool Open(IntPtr owner){return OpenClipboard(owner);} public bool Close(){return CloseClipboard();}
 static bool CanAccessClipboard(){
  IntPtr current=GetProcessWindowStation();if(current==IntPtr.Zero)return false;
  var name=new System.Text.StringBuilder(512);uint needed;
  if(!GetUserObjectInformationW(current,2,name,(uint)(name.Capacity*2),out needed)||needed<2||needed>name.Capacity*2||name.Length==0)return false;
  // Reopen only the current station with WINSTA_ACCESSCLIPBOARD. Never switch
  // stations or seed/clear clipboard data to manufacture a nonzero sequence.
  IntPtr proof=OpenWindowStationW(name.ToString(),false,0x0004);if(proof==IntPtr.Zero)return false;
  return CloseWindowStation(proof);
 }
 internal static uint CheckSequenceAccess(uint sequence,Func<bool> hasAccess){
  if(sequence!=0)return sequence;
  bool allowed=false;try{allowed=hasAccess!=null&&hasAccess();}catch{}
  if(!allowed)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest clipboard access rights could not be verified.");
  return sequence;
 }
 public uint Sequence(){return CheckSequenceAccess(GetClipboardSequenceNumber(),CanAccessClipboard);}
 public uint NextFormat(uint previous){SetLastError(0);uint value=EnumClipboardFormats(previous);if(value==0&&Marshal.GetLastWin32Error()!=0)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest clipboard formats could not be inspected.");return value;}
 public bool HasFormat(uint format){return IsClipboardFormatAvailable(format);} public IntPtr GetData(uint format){return GetClipboardData(format);}
 public ulong Size(IntPtr memory){return GlobalSize(memory).ToUInt64();} public IntPtr Lock(IntPtr memory){return GlobalLock(memory);}
 public void Unlock(IntPtr memory){GlobalUnlock(memory);} public IntPtr Allocate(uint bytes){return GlobalAlloc(0x0042,new UIntPtr(bytes));}
 public void Free(IntPtr memory){if(memory!=IntPtr.Zero)GlobalFree(memory);} public bool Empty(){return EmptyClipboard();}
 public IntPtr SetData(uint format,IntPtr memory){return SetClipboardData(format,memory);}
}
public static class BLACKICEGuestClipboard {
 const uint UnicodeText=13; const int MaximumCharacters=65536;
 static readonly IBLACKICEClipboardApi Native=new BLACKICEClipboardWin32();
 static void RequireSta(){if(System.Threading.Thread.CurrentThread.GetApartmentState()!=System.Threading.ApartmentState.STA)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_STA","Guest clipboard operations require the paired agent STA thread.");}
 public static void ValidateText(string text,bool allowEmpty){
  if(text==null||(!allowEmpty&&text.Length==0)||text.Length>MaximumCharacters)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_TEXT","Clipboard text must fit the 65536 UTF-16 character limit.");
  for(int index=0;index<text.Length;index++){
   char value=text[index];if(value==0)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_TEXT","Clipboard text cannot contain NUL.");
   if(char.IsHighSurrogate(value)){if(index+1>=text.Length||!char.IsLowSurrogate(text[index+1]))throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_TEXT","Clipboard text must contain well-formed Unicode.");index++;}
   else if(char.IsLowSurrogate(value))throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_TEXT","Clipboard text must contain well-formed Unicode.");
  }
 }
 public static uint ValidateSequence(double value){if(double.IsNaN(value)||double.IsInfinity(value)||value<0||value>uint.MaxValue||Math.Floor(value)!=value)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_SEQUENCE","A uint32 guest clipboard sequence is required.");return (uint)value;}
 public static string TextSha256(string text){ValidateText(text,true);using(var hash=System.Security.Cryptography.SHA256.Create()){byte[] bytes=hash.ComputeHash(new System.Text.UTF8Encoding(false,true).GetBytes(text));return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();}}
 static uint CheckedSequence(IBLACKICEClipboardApi api){return api.Sequence();}
 static void Authorize(DateTime expires,Func<bool> canCommit,Func<DateTime> clock){
  if(clock().ToUniversalTime()>=expires.ToUniversalTime())throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_EXPIRED","The guest clipboard request expired.");
  if(canCommit==null||!canCommit())throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_CANCELLED","The guest clipboard request was cancelled.");
  if(clock().ToUniversalTime()>=expires.ToUniversalTime())throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_EXPIRED","The guest clipboard request expired before commit.");
 }
 public static System.Collections.Generic.Dictionary<string,object> State(){return InspectWithApi(Native,false);}
 public static System.Collections.Generic.Dictionary<string,object> StateWithApi(IBLACKICEClipboardApi api){return InspectWithApi(api,false);}
 public static System.Collections.Generic.Dictionary<string,object> Read(){return InspectWithApi(Native,true);}
 public static System.Collections.Generic.Dictionary<string,object> ReadWithApi(IBLACKICEClipboardApi api){return InspectWithApi(api,true);}
 static System.Collections.Generic.Dictionary<string,object> InspectWithApi(IBLACKICEClipboardApi api,bool includeText){
  RequireSta();if(api==null)throw new ArgumentNullException("api");IntPtr owner=IntPtr.Zero;bool opened=false;
  try{
   owner=api.CreateOwner();if(owner==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","The guest clipboard owner could not be created.");
   opened=api.Open(owner);if(!opened)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_BUSY","The guest clipboard is in use. No clipboard was changed.");
   CheckedSequence(api);var categories=new System.Collections.Generic.HashSet<string>();uint format=0;int count=0;
   while((format=api.NextFormat(format))!=0){
    if(++count>128){categories.Add("other");break;}
    if(format==1||format==7||format==UnicodeText)categories.Add("text/plain");
    else if(format==2||format==6||format==8||format==17)categories.Add("image");else if(format==15)categories.Add("files");else categories.Add("other");
   }
   bool hasText=api.HasFormat(UnicodeText);if(hasText)categories.Add("text/plain");
   var formats=new System.Collections.Generic.List<string>();foreach(string category in new[]{"text/plain","image","files","other"})if(categories.Contains(category))formats.Add(category);
   var result=new System.Collections.Generic.Dictionary<string,object>{{"sequence",CheckedSequence(api)},{"hasText",hasText},{"formats",formats.ToArray()}};
   // State deliberately never retrieves clipboard contents or renders formats.
   if(includeText){
    result["characters"]=0;
    if(hasText){
     IntPtr memory=api.GetData(UnicodeText);if(memory==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest Unicode clipboard text is unavailable.");
     ulong bytes=api.Size(memory);if(bytes<2)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_TEXT","Guest Unicode clipboard data is invalid.");
     IntPtr pointer=api.Lock(memory);if(pointer==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest clipboard text could not be locked.");
     string text=null;
     try{int limit=(int)Math.Min(bytes/2,(ulong)MaximumCharacters+1);for(int index=0;index<limit;index++)if(Marshal.ReadInt16(pointer,index*2)==0){text=Marshal.PtrToStringUni(pointer,index);break;}}
     finally{api.Unlock(memory);}
     if(text==null)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_TEXT","Guest clipboard text exceeds its bound or lacks a terminator.");
     ValidateText(text,true);result["sequence"]=CheckedSequence(api);result["characters"]=text.Length;result["text"]=text;result["sha256"]=TextSha256(text);
    }
   }
   if(!api.Close())throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest clipboard inspection could not be closed.");opened=false;return result;
  }finally{try{if(opened)api.Close();}finally{api.DestroyOwner(owner);}}
 }
 public static System.Collections.Generic.Dictionary<string,object> Write(string text,uint expectedSequence,DateTime expires,Func<bool> canCommit){return WriteWithApi(text,expectedSequence,expires,canCommit,()=>DateTime.UtcNow,Native);}
 public static System.Collections.Generic.Dictionary<string,object> WriteWithApi(string text,uint expectedSequence,DateTime expires,Func<bool> canCommit,Func<DateTime> clock,IBLACKICEClipboardApi api){
  RequireSta();ValidateText(text,false);
  if(api==null||clock==null)throw new ArgumentNullException("api");Authorize(expires,canCommit,clock);
  string sha256=TextSha256(text);byte[] encoded=System.Text.Encoding.Unicode.GetBytes(text+"\0");IntPtr memory=IntPtr.Zero,owner=IntPtr.Zero;bool opened=false,transferred=false,emptied=false;
  try{
   // Allocate and fill the complete UTF-16 payload before acquiring the clipboard.
   memory=api.Allocate((uint)encoded.Length);if(memory==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest clipboard memory allocation failed.");
   IntPtr pointer=api.Lock(memory);if(pointer==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","Guest clipboard memory could not be prepared.");
   try{Marshal.Copy(encoded,0,pointer,encoded.Length);}finally{api.Unlock(memory);}
   owner=api.CreateOwner();if(owner==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","The guest clipboard owner could not be created.");
   opened=api.Open(owner);if(!opened)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_BUSY","The guest clipboard is in use. No clipboard was changed.");
   if(CheckedSequence(api)!=expectedSequence)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_SEQUENCE_CHANGED","The guest clipboard changed before the transfer. No clipboard was changed.");
   // The sequence check, last cancellation/expiry check, Empty and Set all run
   // while this owner holds OpenClipboard. No other writer can race the CAS.
   Authorize(expires,canCommit,clock);
   if(!api.Empty())throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_UNAVAILABLE","The guest clipboard could not be replaced.");emptied=true;
   if(api.SetData(UnicodeText,memory)==IntPtr.Zero)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_WRITE_UNCERTAIN","Guest clipboard replacement failed after commit began. Do not replay it.",true);
   transferred=true;uint sequence=CheckedSequence(api);
   if(!api.Close())throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_WRITE_UNCERTAIN","Guest clipboard completion could not be confirmed. Do not replay it.",true);opened=false;
   return new System.Collections.Generic.Dictionary<string,object>{{"written",true},{"sequence",sequence},{"characters",text.Length},{"sha256",sha256}};
  }catch(BLACKICEClipboardException error){if(emptied&&!error.ClipboardMayHaveChanged)throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_WRITE_UNCERTAIN","Guest clipboard completion could not be confirmed. Do not replay it.",true);throw;}
  catch{throw new BLACKICEClipboardException("WORKBENCH_CLIPBOARD_WRITE_UNCERTAIN","Guest clipboard delivery could not be confirmed. Do not replay it.",emptied);}
  finally{try{if(opened)api.Close();}finally{try{if(!transferred&&memory!=IntPtr.Zero)api.Free(memory);}finally{Array.Clear(encoded,0,encoded.Length);api.DestroyOwner(owner);}}}
 }
}
'@
$ClipboardSta=([Threading.Thread]::CurrentThread.GetApartmentState() -eq [Threading.ApartmentState]::STA)
$AgentCapabilities=@('probe','capture','launch','click','type','key','windows','batch_install')
if($ClipboardSta){$AgentCapabilities+=@('clipboard_state','clipboard_read','clipboard_write')}
$DisplayReady=$false
$DisplayCompanion=Join-Path $PSScriptRoot 'guest-display.ps1'
if(Test-Path -LiteralPath $DisplayCompanion -PathType Leaf){
  try{. $DisplayCompanion;$DisplayReady=$null -ne (Get-Command Get-BLACKICEGuestDisplayInfo -ErrorAction Stop) -and
    $null -ne (Get-Command Set-BLACKICEGuestDisplaySize -ErrorAction Stop)}catch{$DisplayReady=$false}
}
if($DisplayReady){$AgentCapabilities+=@('display_info','display_resize')}
function Test-GuestJsonNumber($Value){
  if($null -eq $Value){return $false}
  return [Type]::GetTypeCode($Value.GetType()) -in @([TypeCode]::Byte,[TypeCode]::SByte,
    [TypeCode]::Int16,[TypeCode]::UInt16,[TypeCode]::Int32,[TypeCode]::UInt32,
    [TypeCode]::Int64,[TypeCode]::UInt64,[TypeCode]::Single,[TypeCode]::Double,[TypeCode]::Decimal)
}
function Assert-GuestArgumentKeys($Arguments,[string[]]$Keys){
  if($Arguments -isnot [pscustomobject]){throw 'Guest command arguments must be an object.'}
  $actual=@($Arguments.PSObject.Properties|ForEach-Object {$_.Name})
  if(@($actual|Where-Object {$_ -notin $Keys}).Count -gt 0 -or
    @($Keys|Where-Object {$_ -notin $actual}).Count -gt 0){throw 'Guest command arguments are invalid.'}
}
function Assert-BoundGuestRequest($Request){
  if($Request.requestId -isnot [string] -or $Request.requestId -notmatch '^[a-f0-9]{32}$' -or
    $Request.expectedAgentId -isnot [string] -or
    !([string]$Request.expectedAgentId).Equals($AgentId,[StringComparison]::Ordinal) -or
    !(Test-GuestJsonNumber $Request.expectedGuestSessionId) -or
    [double]$Request.expectedGuestSessionId -ne $SessionId){
    throw 'The request belongs to a different paired guest agent or session.'
  }
  $issued=[datetimeoffset]::MinValue;$expires=[datetimeoffset]::MinValue
  if($Request.issuedAt -isnot [string] -or $Request.expiresAt -isnot [string] -or
    $Request.issuedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$' -or
    $Request.expiresAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$' -or
    ![datetimeoffset]::TryParse($Request.issuedAt,[Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None,[ref]$issued) -or
    ![datetimeoffset]::TryParse($Request.expiresAt,[Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None,[ref]$expires)){
    throw 'The paired guest request deadline is invalid.'
  }
  $ttl=($expires-$issued).TotalMilliseconds
  $now=[datetime]::UtcNow
  if($ttl -lt 1000 -or $ttl -gt 10000 -or $expires.UtcDateTime -le $now -or
    ($expires.UtcDateTime-$now).TotalMilliseconds -gt 10000){
    throw 'The paired guest request expired or exceeds its bounded deadline.'
  }
  $cancelPath=Join-Path $Requests ($Request.requestId+'.cancel.json')
  $requestPath=Join-Path $Requests ($Request.requestId+'.json')
  if([IO.File]::Exists($cancelPath) -or ![IO.File]::Exists($requestPath)){
    throw 'The paired guest request was cancelled.'
  }
  return @{Expires=$expires.UtcDateTime;CancelPath=$cancelPath;RequestPath=$requestPath}
}
function Save-Json([string]$File, $Value){
  $path=[IO.Path]::GetFullPath($File)
  $prefix=[IO.Path]::GetFullPath($Bridge).TrimEnd('\')+'\'
  if(!$path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Guest metadata must stay inside the configured bridge.'}
  [BLACKICEGuestJson]::Publish($path,($Value|ConvertTo-Json -Compress -Depth 8))
}
function Register-ClipboardResponseExpiry($Request){
  $id=[string]$Request.requestId;$kind=[string]$Request.kind
  if($id -notmatch '^[a-f0-9]{32}$' -or $kind -notin @('clipboard_state','clipboard_read','clipboard_write')){
    throw 'Invalid private clipboard expiry identity.'
  }
  $expiry=[DateTimeOffset]::Parse([string]$Request.expiresAt,[Globalization.CultureInfo]::InvariantCulture)
  # Publish this proof before any clipboard text. It survives host/agent exits,
  # and permits cleanup without reading clipboard data or generic history.
  Save-Json (Join-Path $ClipboardExpiry ($id+'.json')) ([ordered]@{version=1;requestId=$id;kind=$kind;
    agentId=$AgentId;guestSessionId=$SessionId;expiresAt=$expiry.UtcDateTime.ToString('o')})
}
function Remove-ExpiredClipboardResponses{
  $now=[DateTimeOffset]::UtcNow
  if($script:LastClipboardCleanup -and ($now-$script:LastClipboardCleanup).TotalMilliseconds -lt 1000){return}
  $script:LastClipboardCleanup=$now
  $items=@(Get-ChildItem -LiteralPath $ClipboardExpiry -Filter '*.json' -File -ErrorAction Stop|Select-Object -First 20)
  foreach($item in $items){
    $id=$item.BaseName
    try{
      $valid=$id -match '^[a-f0-9]{32}$' -and $item.Length -le 2048 -and
        !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
      $record=$null
      if($valid){
        $content=Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop
        try{$record=$content|ConvertFrom-Json -ErrorAction Stop}catch{$record=$null}
      }
      $expiry=[DateTimeOffset]::MinValue
      $valid=$valid -and $record.version -eq 1 -and $record.requestId -ceq $id -and
        [string]$record.kind -in @('clipboard_state','clipboard_read','clipboard_write') -and
        [string]$record.agentId -match '^[a-f0-9]{32}$' -and [int]$record.guestSessionId -gt 0 -and
        [string]$record.expiresAt -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' -and
        [DateTimeOffset]::TryParse([string]$record.expiresAt,[Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$expiry)
      if(!$valid){Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop;continue}
      if($expiry -le $now){
        # Only a validated private marker can select its exact response path.
        # An older agent ID is expected after restart and is safe to expire.
        Remove-Item -LiteralPath (Join-Path $Responses ($id+'.json')) -Force -ErrorAction SilentlyContinue
        if(Test-Path -LiteralPath (Join-Path $Responses ($id+'.json'))){continue}
        Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
      }
    }catch{
      # An unreadable marker cannot authorize removal of any response.
    }
  }
}
function Write-Heartbeat{
  try{
    Save-Json (Join-Path $Bridge 'agent-state.json') ([ordered]@{
      version=1
      agentId=$AgentId
      heartbeatAt=(Get-Date).ToUniversalTime().ToString('o')
      guestName=$env:COMPUTERNAME
      guestRoot=$WorkspaceRoot
      sessionId=$SessionId
      interactive=$Interactive
      privileges=$GuestPrivileges
      capabilities=$AgentCapabilities
      publication=[ordered]@{failures=[int]$script:HeartbeatPublicationFailures;
        lastFailureAt=$script:HeartbeatPublicationFailureAt;lastErrorCode=$script:HeartbeatPublicationErrorCode}
    })
  }catch{
    $script:HeartbeatPublicationFailures=[int][math]::Min(2147483647,([double]$script:HeartbeatPublicationFailures+1))
    $script:HeartbeatPublicationFailureAt=[datetime]::UtcNow.ToString('o')
    $script:HeartbeatPublicationErrorCode=0
    for($failure=$_.Exception;$failure;$failure=$failure.InnerException){
      if($failure -is [ComponentModel.Win32Exception]){$script:HeartbeatPublicationErrorCode=$failure.NativeErrorCode;break}
    }
    # Retain the last complete heartbeat. The next successful publication
    # reports this bounded diagnostic, while readers still enforce its real
    # timestamp and may never accept stale identity during an outage.
    throw
  }
}
function Run-GuestAction($Request){
  $a=$Request.args
  switch([string]$Request.kind){
    'display_info'{
      if(!$DisplayReady){throw 'The guest display companion is unavailable.'}
      Assert-GuestArgumentKeys $a @('guestSessionId')
      if(!(Test-GuestJsonNumber $a.guestSessionId) -or [double]$a.guestSessionId -ne $SessionId){throw 'Guest display session changed.'}
      $null=Assert-BoundGuestRequest $Request
      return Get-BLACKICEGuestDisplayInfo -WorkspaceRoot $WorkspaceRoot -GuestSessionId $SessionId
    }
    'display_resize'{
      if(!$DisplayReady){throw 'The guest display companion is unavailable.'}
      Assert-GuestArgumentKeys $a @('width','height','guestSessionId')
      if(!(Test-GuestJsonNumber $a.guestSessionId) -or [double]$a.guestSessionId -ne $SessionId -or
        !(Test-GuestJsonNumber $a.width) -or !(Test-GuestJsonNumber $a.height) -or
        [double]$a.width -ne [int]$a.width -or [double]$a.height -ne [int]$a.height){throw 'Guest display arguments are invalid.'}
      $guard=Assert-BoundGuestRequest $Request
      $cancelPath=$guard.CancelPath;$requestPath=$guard.RequestPath;$expires=$guard.Expires
      $canApply={ [datetime]::UtcNow -lt $expires -and [IO.File]::Exists($requestPath) -and ![IO.File]::Exists($cancelPath) }.GetNewClosure()
      return Set-BLACKICEGuestDisplaySize -Width ([int]$a.width) -Height ([int]$a.height) -WorkspaceRoot $WorkspaceRoot -GuestSessionId $SessionId -CanApply $canApply
    }
    'clipboard_state'{
      if(!$ClipboardSta){throw 'Clipboard metadata requires the paired STA guest agent.'}
      Assert-GuestArgumentKeys $a @()
      $null=Assert-BoundGuestRequest $Request
      return [BLACKICEGuestClipboard]::State()
    }
    'clipboard_read'{
      if(!$ClipboardSta){throw 'Clipboard reads require the paired STA guest agent.'}
      Assert-GuestArgumentKeys $a @()
      $null=Assert-BoundGuestRequest $Request
      return [BLACKICEGuestClipboard]::Read()
    }
    'clipboard_write'{
      if(!$ClipboardSta){throw 'Clipboard writes require the paired STA guest agent.'}
      Assert-GuestArgumentKeys $a @('text','expectedSequence')
      if($a.text -isnot [string] -or !(Test-GuestJsonNumber $a.expectedSequence)){
        throw 'Clipboard text and sequence must have their expected JSON types.'
      }
      [BLACKICEGuestClipboard]::ValidateText($a.text,$false)
      $sequence=[BLACKICEGuestClipboard]::ValidateSequence([double]$a.expectedSequence)
      $guard=Assert-BoundGuestRequest $Request
      $cancelPath=$guard.CancelPath;$requestPath=$guard.RequestPath
      $canCommit=[Func[bool]]({
        [IO.File]::Exists($requestPath) -and ![IO.File]::Exists($cancelPath)
      }.GetNewClosure())
      return [BLACKICEGuestClipboard]::Write($a.text,$sequence,$guard.Expires,$canCommit)
    }
    'probe'{
      if([string]$a.nonce -notmatch '^[a-f0-9]{32}$'){throw 'Invalid shared-folder probe nonce.'}
      return @{nonce=[string]$a.nonce;readHostFile=$true;guestRoot=$WorkspaceRoot}
    }
    'capture'{
      $rect=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      if($rect.Width -lt 10 -or $rect.Height -lt 10){throw 'Interactive guest display bounds unavailable.'}
      $image=New-Object System.Drawing.Bitmap($rect.Width,$rect.Height)
      try{
        $canvas=[System.Drawing.Graphics]::FromImage($image)
        try{$canvas.CopyFromScreen($rect.Location,[System.Drawing.Point]::Empty,$rect.Size)}
        finally{$canvas.Dispose()}
        $file=Join-Path $Frames ($Request.requestId+'.png')
        $image.Save($file,[System.Drawing.Imaging.ImageFormat]::Png)
        $sha=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        return @{width=$rect.Width;height=$rect.Height;sha256=$sha}
      }finally{$image.Dispose()}
    }
    'launch'{
      $exe=[string]$a.appPath
      if(!$exe -or ![IO.Path]::IsPathRooted($exe) -or !(Test-Path -LiteralPath $exe -PathType Leaf)){
        throw 'The executable path does not exist inside the Windows guest.'
      }
      $params=@{FilePath=$exe;PassThru=$true;ErrorAction='Stop'}
      if($a.arguments){$params.ArgumentList=@($a.arguments)}
      if($a.cwd){
        if(![IO.Path]::IsPathRooted([string]$a.cwd) -or !(Test-Path -LiteralPath $a.cwd -PathType Container)){
          throw 'The guest working folder is unavailable.'
        }
        $params.WorkingDirectory=[string]$a.cwd
      }
      $started=Start-Process @params
      return @{processId=[int]$started.Id;name=[string]$started.ProcessName;guestLaunched=$true}
    }
    'batch_install'{
      $runId=[string]$a.runId
      $snapshotId=[string]$a.snapshotId
      $sha=[string]$a.manifestSha256
      if($runId -notmatch '^[a-f0-9]{32}$' -or $snapshotId -notmatch '^[a-f0-9]{32}$' -or
        $sha -notmatch '^[a-f0-9]{64}$'){throw 'Invalid host package batch identity.'}
      $appSync=Join-Path $Bridge 'app-sync'
      $runFile=Join-Path (Join-Path $appSync 'runs') ($runId+'.json')
      $manifest=$null
      $worker=Join-Path $Bridge 'guest-app-batch.ps1'
      if(!(Test-Path -LiteralPath $worker) -or !(Test-Path -LiteralPath $runFile)){
        throw 'Host app inventory or guest batch worker is unavailable.'
      }
      $status=Get-Content -LiteralPath $runFile -Raw|ConvertFrom-Json
      $variant=[string]$status.importVariant
      if($variant -and $variant -notin @('original','augmented')){throw 'Invalid guest import variant.'}
      $manifestName=if($variant -eq 'augmented'){$snapshotId+'.augmented-'+$sha.Substring(0,16)+'.json'}else{$snapshotId+'.json'}
      $manifest=Join-Path (Join-Path $appSync 'manifests') $manifestName
      if(!(Test-Path -LiteralPath $manifest)){throw 'The saved guest import manifest is missing.'}
      if($status.version -ne 1 -or $status.snapshotId -ne $snapshotId -or
        $status.manifestSha256 -ne $sha -or $status.runId -ne $runId -or
        $status.status -ne 'requested'){throw 'This package batch was already started or belongs to a different host inventory.'}
      if((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){
        throw 'The host app inventory differs from its saved checksum.'
      }
      $safeWorker='"'+$worker.Replace('"','')+'"'
      $safeRoot='"'+$WorkspaceRoot.Replace('"','')+'"'
      $params='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '+$safeWorker+
        ' -WorkspaceRoot '+$safeRoot+' -RunId '+$runId+' -SnapshotId '+$snapshotId
      $child=Start-Process -FilePath 'powershell.exe' -ArgumentList $params -WindowStyle Hidden -PassThru -ErrorAction Stop
      return @{scheduled=$true;runId=$runId;snapshotId=$snapshotId;workerPid=[int]$child.Id;
        message='Batch installation dispatched in the guest; inspect the batch run receipt for completion.'}
    }
    'windows'{
      $items=@(Get-Process |Where-Object {$_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle}|
        Select-Object -First 80 |ForEach-Object {@{pid=[int]$_.Id;title=[string]$_.MainWindowTitle;
          handle=[string]$_.MainWindowHandle;name=[string]$_.ProcessName}})
      return @{windows=$items}
    }
    'click'{
      $x=[int]$a.x;$y=[int]$a.y
      $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      if($x -lt 0 -or $y -lt 0 -or $x -ge $bounds.Width -or $y -ge $bounds.Height){
        throw 'Coordinates are outside the guest screen.'
      }
      [BLACKICEGuestMouse]::Click($x+$bounds.Left,$y+$bounds.Top)
      return @{clicked=$true;x=$x;y=$y}
    }
    'type'{
      $text=[string]$a.text
      if($text.Length -gt 10000){throw 'Typed content exceeds the bound.'}
      [System.Windows.Forms.Clipboard]::SetText($text)
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      return @{sent=$true;characters=$text.Length}
    }
    'key'{
      $map=@{'ENTER'='{ENTER}';'ESC'='{ESC}';'TAB'='{TAB}';'BACKSPACE'='{BACKSPACE}';
        'CTRL+A'='^a';'ALT+TAB'='%{TAB}'}
      $key=[string]$a.key
      if(!$map.ContainsKey($key)){throw 'Unsupported guest keyboard shortcut.'}
      [System.Windows.Forms.SendKeys]::SendWait($map[$key])
      return @{sent=$true;key=$key}
    }
    default{throw 'Unsupported guest action.'}
  }
}
while($true){
  try{
    Remove-ExpiredClipboardResponses
    Write-Heartbeat
    $queue=@(Get-ChildItem -LiteralPath $Requests -Filter '*.json' -File -ErrorAction Stop|
      Sort-Object CreationTimeUtc|Select-Object -First 20)
    foreach($entry in $queue){
      $id=$entry.BaseName
      if($id -notmatch '^[a-f0-9]{32}$'){continue}
      $responseFile=Join-Path $Responses ($id+'.json')
      $cancelFile=Join-Path $Requests ($id+'.cancel.json')
      if([IO.File]::Exists($cancelFile)){
        Remove-Item -LiteralPath $entry.FullName,$responseFile -Force -ErrorAction SilentlyContinue
        continue
      }
      if(Test-Path -LiteralPath $responseFile){Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction SilentlyContinue;continue}
      $marker=Join-Path $Processing ($id+'.json')
      if(Test-Path -LiteralPath $marker){
        # A prior action may have launched an application before losing its
        # response. Do not replay it; preserve the uncertainty visibly.
        Save-Json $responseFile ([ordered]@{version=1;requestId=$id;kind='unknown';status='failed';
          agentId=$AgentId;guestSessionId=$SessionId;error='An earlier attempt was interrupted. Its side effect is uncertain; do not retry blindly.';
          finishedAt=(Get-Date).ToUniversalTime().ToString('o')})
        Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction SilentlyContinue
        continue
      }
      $request=$null;$clipboardRequest=$false
      try{
        $request=[IO.File]::ReadAllText($entry.FullName,[Text.UTF8Encoding]::new($false,$true))|ConvertFrom-Json
        $clipboardRequest=[string]$request.kind -in @('clipboard_state','clipboard_read','clipboard_write')
        if($request.version -ne 1 -or $request.requestId -ne $id -or
          (Get-Date).ToUniversalTime() -gt [datetime]::Parse([string]$request.expiresAt).ToUniversalTime()){
          throw 'Guest request is invalid or expired.'
        }
        Save-Json $marker ([ordered]@{requestId=$id;agentId=$AgentId;beganAt=(Get-Date).ToUniversalTime().ToString('o')})
        $answer=Run-GuestAction $request
        $record=[ordered]@{version=1;requestId=$id;kind=[string]$request.kind;status='completed';
          agentId=$AgentId;guestSessionId=$SessionId;result=$answer;
          finishedAt=(Get-Date).ToUniversalTime().ToString('o')}
      }catch{
        $failure=$_.Exception
        while($failure.InnerException -and $failure -isnot [BLACKICEClipboardException]){$failure=$failure.InnerException}
        $record=[ordered]@{version=1;requestId=$id;kind=if($request){[string]$request.kind}else{'unknown'};
          status='failed';agentId=$AgentId;guestSessionId=$SessionId;
          error=if($clipboardRequest){'The guest clipboard operation was not confirmed.'}elseif(!$request){'The guest request could not be read.'}else{$_.Exception.Message};
          finishedAt=(Get-Date).ToUniversalTime().ToString('o')}
        if($clipboardRequest -and $failure -is [BLACKICEClipboardException]){
          $record.code=$failure.Code;$record.clipboardMayHaveChanged=$failure.ClipboardMayHaveChanged
        }
      }
      if(!$clipboardRequest -or ![IO.File]::Exists($cancelFile)){
        if($clipboardRequest){Register-ClipboardResponseExpiry $request}
        Save-Json $responseFile $record
      }
      # Host timeout cancellation can race response publication. Keep text out
      # of the shared folder once that durable cancellation has been observed.
      if($clipboardRequest -and [IO.File]::Exists($cancelFile)){
        Remove-Item -LiteralPath $responseFile -Force -ErrorAction SilentlyContinue
      }
      Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction SilentlyContinue
    }
  }catch{
    # The mapped folder may reconnect after a VM guest resume. Never switch
    # to another path or run pending actions without their original receipts.
  }
  Start-Sleep -Milliseconds 100
}
