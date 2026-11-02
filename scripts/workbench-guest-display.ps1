# Guest-only companion. No host input, registry writes, power or RDP changes.
if(-not ('BLACKICEGuestDisplay' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class BLACKICEGuestDisplay {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Mode {
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
  public ushort spec,driver,size,extra; public uint fields; public int x,y; public uint orientation,fixedOutput;
  public short color,duplex,yResolution,ttOption,collate;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string form;
  public ushort logPixels; public uint bits,width,height,flags,frequency,icmMethod,icmIntent,media,dither,reserved1,reserved2,panningWidth,panningHeight;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Device {
  public uint cb; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string description; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string id;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string key;
 }
 public sealed class Size { public uint width,height,bpp,frequency; }
 public sealed class Info { public string device; public bool supported,remoteSession; public Size current; public List<Size> modes; }
 public sealed class Result { public bool changed,confirmed; public Size requested,before,actual; public int testCode,applyCode; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern bool EnumDisplayDevicesW(string name,uint index,ref Device device,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern bool EnumDisplaySettingsW(string name,uint index,ref Mode mode);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int ChangeDisplaySettingsExW(string name,ref Mode mode,IntPtr hwnd,uint flags,IntPtr parameter);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 static Mode NewMode(){return new Mode{size=(ushort)Marshal.SizeOf(typeof(Mode))};}
 static Size Describe(Mode m){return new Size{width=m.width,height=m.height,bpp=m.bits,frequency=m.frequency};}
 public static void ValidateDimensions(int width,int height){if(width<640||height<480||width>4096||height>4096)throw new ArgumentException("Guest resolution is outside supported bounds.");}
 static string Primary(){
  string name=null;
  for(uint i=0;i<16;i++){var d=new Device{cb=(uint)Marshal.SizeOf(typeof(Device))};if(!EnumDisplayDevicesW(null,i,ref d,0))break;if((d.flags&5)==5){if(name!=null)throw new InvalidOperationException("Multiple primary guest displays are unsupported.");name=d.name;}}
  if(name==null)throw new InvalidOperationException("Primary guest display unavailable.");return name;
 }
 static Mode Current(string name){var mode=NewMode();if(!EnumDisplaySettingsW(name,uint.MaxValue,ref mode))throw new InvalidOperationException("Current guest mode unavailable.");return mode;}
 static List<Mode> Modes(string name){
  var values=new List<Mode>();
  for(uint i=0;i<512;i++){var m=NewMode();if(!EnumDisplaySettingsW(name,i,ref m))return values;if(m.bits==32&&m.width>=640&&m.height>=480&&m.width<=4096&&m.height<=4096)values.Add(m);}
  throw new InvalidOperationException("Guest mode enumeration exceeded its bound.");
 }
 public static Info Read(){
  string name=Primary();var values=new List<Size>();var seen=new HashSet<string>();
  foreach(var m in Modes(name))if(seen.Add(m.width+"x"+m.height))values.Add(Describe(m));
  bool remote=GetSystemMetrics(0x1000)!=0;return new Info{device=name,remoteSession=remote,supported=!remote&&values.Count>0,current=Describe(Current(name)),modes=values};
 }
 public static Result Resize(int width,int height){return Resize(width,height,()=>true);}
 public static Result Resize(int width,int height,Func<bool> canApply){
  ValidateDimensions(width,height);if(canApply==null||!canApply())throw new InvalidOperationException("Guest display request expired or was cancelled.");
  if(GetSystemMetrics(0x1000)!=0)throw new InvalidOperationException("Temporary local-console resizing is unavailable in a remote guest session.");
  string name=Primary();var before=Current(name);var requested=new Size{width=(uint)width,height=(uint)height,bpp=32};
  if(before.width==width&&before.height==height)return new Result{confirmed=true,changed=false,requested=requested,before=Describe(before),actual=Describe(before)};
  Mode selected=NewMode();bool found=false;
  foreach(var candidate in Modes(name))if(candidate.width==width&&candidate.height==height){selected=candidate;found=true;if(candidate.frequency==before.frequency)break;}
  if(!found)throw new InvalidOperationException("Requested resolution is not an enumerated guest display mode.");
  selected.fields=0x00080000|0x00100000|0x00040000;
  if(!canApply())throw new InvalidOperationException("Guest display request expired or was cancelled.");
  int test=ChangeDisplaySettingsExW(name,ref selected,IntPtr.Zero,2,IntPtr.Zero);
  if(test!=0)throw new InvalidOperationException("Guest display mode test failed: "+test);
  // Flags zero changes this interactive display now, without registry/global persistence.
  if(!canApply())throw new InvalidOperationException("Guest display request expired or was cancelled.");
  int applied=ChangeDisplaySettingsExW(name,ref selected,IntPtr.Zero,0,IntPtr.Zero);
  if(applied!=0)throw new InvalidOperationException("Guest display mode was not applied: "+applied);
  var actual=Current(name);
  for(int i=0;i<20&&(actual.width!=width||actual.height!=height);i++){Thread.Sleep(50);actual=Current(name);}
  return new Result{confirmed=actual.width==width&&actual.height==height,changed=actual.width!=before.width||actual.height!=before.height,requested=requested,before=Describe(before),actual=Describe(actual),testCode=test,applyCode=applied};
 }
}
'@
}
function Assert-BLACKICEGuestDisplayContext([string]$WorkspaceRoot,[int]$GuestSessionId){
  $info=Get-Content -LiteralPath (Join-Path $WorkspaceRoot '.blackice-workbench\host-info.json') -Raw|ConvertFrom-Json
  if(!$info.hostName -or ([string]$info.hostName).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){throw 'Refusing to change or inspect host display settings.'}
  $currentSession=[Diagnostics.Process]::GetCurrentProcess().SessionId
  if(![Environment]::UserInteractive -or $currentSession -le 0 -or $currentSession -ne $GuestSessionId){throw 'The paired interactive guest session changed.'}
}
function Get-BLACKICEGuestDisplayInfo([string]$WorkspaceRoot,[int]$GuestSessionId){
  Assert-BLACKICEGuestDisplayContext $WorkspaceRoot $GuestSessionId
  return [BLACKICEGuestDisplay]::Read()
}
function Set-BLACKICEGuestDisplaySize([int]$Width,[int]$Height,[string]$WorkspaceRoot,[int]$GuestSessionId,[scriptblock]$CanApply={$true}){
  Assert-BLACKICEGuestDisplayContext $WorkspaceRoot $GuestSessionId
  return [BLACKICEGuestDisplay]::Resize($Width,$Height,[Func[bool]]$CanApply)
}
