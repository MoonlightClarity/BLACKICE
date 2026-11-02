# Independent readback of ONLY the verified synthetic native child. Never paints.
param([Parameter(Mandatory=$true)][string]$MetadataPath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$metadata=Get-Content -LiteralPath $MetadataPath -Raw|ConvertFrom-Json
if($metadata.durationMs -lt 3000 -or $metadata.durationMs -gt 6000 -or $metadata.helperPid -le 0 -or
  [string]$metadata.workbenchWindowHwnd -notmatch '^\d+$' -or [string]$metadata.childHwnd -notmatch '^\d+$'){throw 'Bounded exact owned-window identity required.'}
if(Test-Path -LiteralPath $OutputPath){throw 'Fresh readback output required.'}
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Diagnostics;using System.IO;using System.Runtime.InteropServices;using System.Threading;
public static class BLACKICEPresentationReadback {
 [StructLayout(LayoutKind.Sequential)]struct RECT{public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)]struct POINT{public int x,y;public POINT(int a,int b){x=a;y=b;}}
 [StructLayout(LayoutKind.Sequential)]struct BIH{public uint size;public int width,height;public ushort planes,bits;public uint compression,imageSize;public int x,y;public uint used,important;}
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetParent(IntPtr window);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr window,uint flags);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll")]static extern IntPtr GetDC(IntPtr window);
 [DllImport("user32.dll")]static extern int ReleaseDC(IntPtr window,IntPtr dc);
 [DllImport("gdi32.dll")]static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")]static extern bool DeleteDC(IntPtr dc);
 [DllImport("gdi32.dll")]static extern IntPtr CreateDIBSection(IntPtr dc,ref BIH info,uint usage,out IntPtr bits,IntPtr section,uint offset);
 [DllImport("gdi32.dll")]static extern IntPtr SelectObject(IntPtr dc,IntPtr item);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr item);
 [DllImport("gdi32.dll",SetLastError=true)]static extern bool BitBlt(IntPtr target,int x,int y,int width,int height,IntPtr source,int sx,int sy,uint operation);
 [DllImport("gdi32.dll")]static extern bool GdiFlush();
 public sealed class Sample {public double atMs;public bool black,flat,counterValid;public uint counter;public double darkFraction;}
 public sealed class Result {public string method="exact-child-getdc-bitblt-gdi-surface";public int samplesRead,blackFrames,flatFrames,invalidCounterFrames,validCounterRegressions,distinctValidCounters,width,height;public double durationMs,observerSamplesPerSecond;public bool ownerVerified=true,occlusionChecked=true,printWindowUsed=false,forcedPaint=false,desktopCaptured=false;public List<Sample> samples=new List<Sample>();}
 static int[] Pixel(byte[] pixels,int width,int height,int sx,int sy){int x=Math.Max(0,Math.Min(width-1,(int)Math.Floor(sx*width/1920.0))),y=Math.Max(0,Math.Min(height-1,(int)Math.Floor(sy*height/1080.0)));int at=(y*width+x)*4;return new int[]{pixels[at+2],pixels[at+1],pixels[at]};}
 static int Distance(int[] p,int[] q){return Math.Max(Math.Abs(p[0]-q[0]),Math.Max(Math.Abs(p[1]-q[1]),Math.Abs(p[2]-q[2])));}
 static uint? Row(byte[] pixels,int width,int height,int y,List<int[]> colors){uint value=0;int[] zero={96,160,216},one={240,196,72};for(int bit=0;bit<32;bit++){var p=Pixel(pixels,width,height,32+bit*16+8,y+16);colors.Add(p);int a=Distance(p,zero),b=Distance(p,one);if(Math.Min(a,b)>45||Math.Abs(a-b)<20)return null;if(b<a)value|=1u<<bit;}return value;}
 static uint Crc(uint value){uint crc=0xffffffff;for(int b=0;b<4;b++){crc^=(value>>(8*b))&255;for(int i=0;i<8;i++)crc=(crc>>1)^((crc&1)!=0?0xedb88320u:0);}return crc^0xffffffff;}
 static void SaveBmp(string path,int width,int height,byte[] pixels){using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read))using(var writer=new BinaryWriter(stream)){
  writer.Write((ushort)0x4d42);writer.Write((uint)(54+pixels.Length));writer.Write((uint)0);writer.Write((uint)54);writer.Write((uint)40);writer.Write(width);writer.Write(-height);writer.Write((ushort)1);writer.Write((ushort)32);writer.Write((uint)0);writer.Write((uint)pixels.Length);writer.Write(0);writer.Write(0);writer.Write((uint)0);writer.Write((uint)0);writer.Write(pixels);
 }}
 public static Sample Analyze(byte[] pixels,int width,int height,double at){
  if(width<1||height<1||pixels==null||pixels.Length!=width*height*4)throw new ArgumentException("Owned pixel buffer invalid");
  var colors=new List<int[]>();int dark=0;
  for(int row=0;row<5;row++)for(int column=0;column<8;column++){var p=Pixel(pixels,width,height,100+column*245,370+row*145);colors.Add(p);if(Math.Max(p[0],Math.Max(p[1],p[2]))<32)dark++;}
  uint? value=Row(pixels,width,height,32,colors),crc=Row(pixels,width,height,80,colors);int range=0;
  for(int channel=0;channel<3;channel++){int min=255,max=0;foreach(var p in colors){min=Math.Min(min,p[channel]);max=Math.Max(max,p[channel]);}range=Math.Max(range,max-min);}
  return new Sample{atMs=at,black=dark>=38,flat=range<=6,darkFraction=dark/40.0,counter=value??0,counterValid=value.HasValue&&crc.HasValue&&Crc(value.Value)==crc.Value};
 }
 static void Verify(IntPtr root,IntPtr child,uint pid,RECT expected){
  uint rootPid,childPid;GetWindowThreadProcessId(root,out rootPid);GetWindowThreadProcessId(child,out childPid);RECT current;
  if(!IsWindow(root)||!IsWindow(child)||!IsWindowVisible(root)||!IsWindowVisible(child)||IsIconic(root)||rootPid!=pid||childPid!=pid||GetParent(child)!=root||GetAncestor(root,2)!=root||!GetWindowRect(child,out current)||
    current.left!=expected.left||current.top!=expected.top||current.right!=expected.right||current.bottom!=expected.bottom)throw new InvalidOperationException("Owned target changed or disappeared");
  foreach(var p in new[]{new POINT(current.left+8,current.top+8),new POINT(current.right-9,current.top+8),new POINT(current.left+8,current.bottom-9),new POINT(current.right-9,current.bottom-9),new POINT((current.left+current.right)/2,(current.top+current.bottom)/2)}){
   IntPtr hit=WindowFromPoint(p);uint hitPid;GetWindowThreadProcessId(hit,out hitPid);if(hitPid!=pid||GetAncestor(hit,2)!=root)throw new InvalidOperationException("Owned native child is occluded; readback rejected");
  }
 }
 public static Result Capture(long rootValue,long childValue,uint pid,int duration,string before,string after){
  if(duration<3000||duration>6000)throw new ArgumentException("Bounded duration required");
  var root=new IntPtr(rootValue);var child=new IntPtr(childValue);IntPtr prior=SetThreadDpiAwarenessContext(new IntPtr(-4));if(prior==IntPtr.Zero)throw new InvalidOperationException("Physical readback context unavailable");
  IntPtr source=IntPtr.Zero,memory=IntPtr.Zero,bitmap=IntPtr.Zero,original=IntPtr.Zero,bits=IntPtr.Zero;
  try{
   RECT client,window;if(!GetClientRect(child,out client)||!GetWindowRect(child,out window))throw new InvalidOperationException("Owned geometry unavailable");
   int width=client.right-client.left,height=client.bottom-client.top;if(width<200||height<120||width>4096||height>4096)throw new InvalidOperationException("Owned client dimensions invalid");
   Verify(root,child,pid,window);source=GetDC(child);if(source==IntPtr.Zero)throw new InvalidOperationException("Owned child DC unavailable");memory=CreateCompatibleDC(source);
   var info=new BIH{size=(uint)Marshal.SizeOf(typeof(BIH)),width=width,height=-height,planes=1,bits=32};bitmap=CreateDIBSection(memory,ref info,0,out bits,IntPtr.Zero,0);
   if(memory==IntPtr.Zero||bitmap==IntPtr.Zero||bits==IntPtr.Zero)throw new InvalidOperationException("Owned readback buffer unavailable");original=SelectObject(memory,bitmap);
   var pixels=new byte[width*height*4];var result=new Result{width=width,height=height};var seen=new HashSet<uint>();uint? previous=null;bool saved=false;
   var watch=Stopwatch.StartNew();double next=0;
   while(watch.Elapsed.TotalMilliseconds<duration){
    Verify(root,child,pid,window);
    if(!BitBlt(memory,0,0,width,height,source,0,0,0x00cc0020))throw new InvalidOperationException("Owned child readback failed");GdiFlush();Marshal.Copy(bits,pixels,0,pixels.Length);
    var sample=Analyze(pixels,width,height,watch.Elapsed.TotalMilliseconds);result.samples.Add(sample);if(sample.black)result.blackFrames++;if(sample.flat)result.flatFrames++;
    if(sample.counterValid){if(previous.HasValue&&sample.counter<previous.Value)result.validCounterRegressions++;previous=sample.counter;seen.Add(sample.counter);
     if(!saved){SaveBmp(before,width,height,pixels);saved=true;}
    }else result.invalidCounterFrames++;
    next+=10;int wait=(int)Math.Floor(next-watch.Elapsed.TotalMilliseconds);if(wait>0)Thread.Sleep(wait);
   }
   if(saved)SaveBmp(after,width,height,pixels);
   result.samplesRead=result.samples.Count;result.durationMs=result.samples.Count>1?result.samples[result.samples.Count-1].atMs-result.samples[0].atMs:0;result.distinctValidCounters=seen.Count;result.observerSamplesPerSecond=result.samplesRead*1000.0/Math.Max(1,result.durationMs);return result;
  }finally{if(original!=IntPtr.Zero)SelectObject(memory,original);if(bitmap!=IntPtr.Zero)DeleteObject(bitmap);if(memory!=IntPtr.Zero)DeleteDC(memory);if(source!=IntPtr.Zero)ReleaseDC(child,source);SetThreadDpiAwarenessContext(prior);}
 }
}
'@
$result=[BLACKICEPresentationReadback]::Capture([long]$metadata.workbenchWindowHwnd,[long]$metadata.childHwnd,[uint32]$metadata.helperPid,[int]$metadata.durationMs,$OutputPath+'.before.bmp',$OutputPath+'.after.bmp')
[IO.File]::WriteAllText($OutputPath,($result|ConvertTo-Json -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
