# Guest-only native display/input acceptance fixture. Never run on the host.
# Stage this file in the guest workspace, then explicitly launch with Windows
# PowerShell -NoProfile -STA -ExecutionPolicy Bypass -File <path> when authorized.
[CmdletBinding()]
param(
  [ValidateRange(20,30)][int]$DurationSeconds=25,
  [ValidateRange(8,100)][int]$FrameIntervalMilliseconds=33,
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$RunId=([guid]::NewGuid().ToString('N')),
  [string]$WorkspaceRoot='W:\'
)
$ErrorActionPreference='Stop'
# Every check precedes Forms loading, output-directory creation, and UI startup.
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'This fixture requires the Windows Hyper-V guest.'}
if([IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\') -ne 'W:'){throw 'This fixture requires the mapped guest workspace W:\.'}
$hostInfoPath='W:\.blackice-workbench\host-info.json'
if(-not (Test-Path -LiteralPath $hostInfoPath -PathType Leaf)){throw 'Guest workspace host-info.json is required.'}
$hostInfo=Get-Content -LiteralPath $hostInfoPath -Raw|ConvertFrom-Json
if($hostInfo.version -ne 1 -or [string]$hostInfo.hostName -notmatch '^[A-Za-z0-9_-]{1,80}$'){
  throw 'The shared workspace has no valid BLACKICE host identity.'
}
if(([string]$hostInfo.hostName).Equals([Environment]::MachineName,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Host execution refused: this computer owns the BLACKICE workspace.'
}
$guestMachine=Get-CimInstance -ClassName Win32_ComputerSystem
if($guestMachine.Model -ne 'Virtual Machine' -or $guestMachine.Manufacturer -notmatch 'Microsoft'){
  throw 'This fixture requires a Microsoft Hyper-V virtual machine.'
}
$guestSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($guestSessionId -le 0 -or -not [Environment]::UserInteractive){throw 'An interactive guest session is required.'}
if([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA){
  throw 'Launch this fixture with Windows PowerShell -STA in the interactive guest.'
}
$outputDirectory='W:\.blackice-workbench\verification'
$metadataPath=Join-Path $outputDirectory ('native-motion-'+$RunId+'.json')
$finalMetadataPath=Join-Path $outputDirectory ('native-motion-'+$RunId+'.final.json')
if((Test-Path -LiteralPath $metadataPath) -or (Test-Path -LiteralPath $finalMetadataPath)){throw 'RunId already has metadata. Choose a fresh RunId.'}

$fixtureSource=@'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Blackice.GuestVerification {
  // Only the background writer touches the shared drive during animation.
  // A single latest snapshot avoids an SMB backlog changing the motion cadence.
  public sealed class SnapshotWriter : IDisposable {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)]
    static extern bool MoveFileExW(string existing,string replacement,uint flags);
    readonly string destination;
    public readonly string FinalDestination;
    readonly object gate = new object();
    readonly AutoResetEvent wake = new AutoResetEvent(false);
    readonly Thread thread;
    string pending;
    bool pendingFinal;
    bool stopping;
    int disposed;
    public volatile string LastError = "";
    public int Writes;
    public volatile bool FinalWritten;
    public SnapshotWriter(string path) {
      destination = path;
      FinalDestination=Path.Combine(Path.GetDirectoryName(path),Path.GetFileNameWithoutExtension(path)+".final.json");
      thread = new Thread(Work); thread.IsBackground = true; thread.Name = "BLACKICE guest fixture metadata"; thread.Start();
    }
    public void Publish(string snapshot) { Publish(snapshot,false); }
    public void Publish(string snapshot,bool final) {
      lock(gate) {if(pendingFinal&&!final)return;pending=snapshot;pendingFinal=final;}wake.Set();
    }
    static void ReplaceSealedTemporary(string temporary,string target) {
      var retry=Stopwatch.StartNew();
      while(true) {
        if(MoveFileExW(temporary,target,1u|8u))return;
        int error=Marshal.GetLastWin32Error();
        // Readers on the mapped share can briefly deny replacement. Retry
        // only this closed/flushed file's rename to its own run's target.
        long remaining=150-retry.ElapsedMilliseconds;
        if((error!=5&&error!=32&&error!=33)||remaining<=0)
          throw new IOException("Metadata rename failed: Win32 "+error);
        Thread.Sleep((int)Math.Min(10,remaining));
      }
    }
    void WriteSnapshot(string target,string snapshot,bool replace) {
      string temporary=target+"."+Guid.NewGuid().ToString("N")+".tmp";
      try {
        using(var file=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
          byte[] data=new UTF8Encoding(false).GetBytes(snapshot);file.Write(data,0,data.Length);file.Flush(true);
        }
        // File.Replace merges destination ACLs and can fail on mapped SMB
        // shares. Same-directory replace-existing rename avoids that operation.
        if(replace)ReplaceSealedTemporary(temporary,target);
        else File.Move(temporary,target);
      } finally {try{if(File.Exists(temporary))File.Delete(temporary);}catch{}}
    }
    void Work() {
      while(true) {
        wake.WaitOne(); string snapshot; bool stop,final;
        lock(gate) {snapshot=pending;pending=null;final=pendingFinal;pendingFinal=false;stop=stopping;}
        if(snapshot != null) {
          try {
            if(final&&!FinalWritten){WriteSnapshot(FinalDestination,snapshot,false);FinalWritten=true;}
            WriteSnapshot(destination,snapshot,true);
            // Exhausted/nontransient failures remain visible in the final
            // fixture metadata even if a later progress snapshot succeeds.
            Interlocked.Increment(ref Writes);
          } catch(Exception error) {
            LastError = error.GetType().Name + ": " + error.Message;
          }
        }
        if(stop) return;
      }
    }
    public void Dispose() {
      if(Interlocked.Exchange(ref disposed,1)!=0) return;
      lock(gate) { stopping = true; } wake.Set();
      // The worker is background-only; a stalled share cannot keep the UI alive.
      if(thread.Join(2000)) wake.Dispose();
    }
  }
  public sealed class DeadlinePacer : IDisposable {
    readonly int period;
    readonly Action callback;
    readonly ManualResetEvent stopped=new ManualResetEvent(false);
    readonly Thread thread;
    int disposed;
    long scheduled,skipped;
    public long ScheduledTicks {get{return Interlocked.Read(ref scheduled);}}
    public long SkippedSlots {get{return Interlocked.Read(ref skipped);}}
    public DeadlinePacer(int milliseconds,Action action) {
      if(milliseconds<1||action==null)throw new ArgumentException("A bounded period and callback are required.");
      period=milliseconds;callback=action;thread=new Thread(Work);thread.IsBackground=true;thread.Name="BLACKICE guest fixture deadline clock";
    }
    public static long SlotForElapsed(double elapsedMilliseconds,int milliseconds) {return (long)Math.Floor(elapsedMilliseconds/milliseconds);}
    public void Start(){thread.Start();}
    void Work() {
      var watch=Stopwatch.StartNew();long lastSlot=0;
      while(!stopped.WaitOne(0)) {
        double now=watch.Elapsed.TotalMilliseconds;long slot=SlotForElapsed(now,period);
        if(slot>lastSlot){Interlocked.Add(ref skipped,slot-lastSlot-1);lastSlot=slot;Interlocked.Increment(ref scheduled);callback();}
        // Absolute deadlines compensate for wait granularity instead of adding
        // the rounding error to every requested 33 ms Forms timer interval.
        double remaining=(lastSlot+1)*period-watch.Elapsed.TotalMilliseconds;
        stopped.WaitOne(Math.Max(1,Math.Min(8,(int)Math.Floor(remaining))));
      }
    }
    public void Dispose(){if(Interlocked.Exchange(ref disposed,1)!=0)return;stopped.Set();if((thread.ThreadState&System.Threading.ThreadState.Unstarted)==0&&thread.Join(500))stopped.Dispose();}
  }
  static class Cadence {
    public static object Summary(List<double> values) {
      if(values.Count==0)return new {count=0,minMs=0.0,p50Ms=0.0,p95Ms=0.0,maxMs=0.0};
      double[] sorted=values.ToArray();Array.Sort(sorted);
      return new {count=sorted.Length,minMs=sorted[0],p50Ms=sorted[(int)Math.Ceiling(sorted.Length*.5)-1],p95Ms=sorted[(int)Math.Ceiling(sorted.Length*.95)-1],maxMs=sorted[sorted.Length-1]};
    }
  }
  sealed class Marker : Control {
    public readonly string MarkerId;
    public bool Toggled;
    public int ClickCount;
    public event Action<Marker,MouseEventArgs> Pressed;
    public string ColorHex { get { return Toggled ? "#10D8FF" : "#FFB000"; } }
    public Marker(string id) { MarkerId = id; DoubleBuffered = true; SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true); }
    protected override void OnPaint(PaintEventArgs e) {
      e.Graphics.Clear(Toggled ? Color.FromArgb(16,216,255) : Color.FromArgb(255,176,0));
      using(var font = new Font("Segoe UI", 24, FontStyle.Bold))
      using(var smaller = new Font("Segoe UI", 15, FontStyle.Regular)) {
        e.Graphics.DrawString(MarkerId.ToUpperInvariant(), font, Brushes.Black, 18, 20);
        e.Graphics.DrawString((Toggled ? "CYAN" : "AMBER") + "  clicks " + ClickCount, smaller, Brushes.Black, 18, 68);
      }
    }
    protected override void OnMouseDown(MouseEventArgs e) {
      base.OnMouseDown(e); if(e.Button != MouseButtons.Left) return;
      Toggled = !Toggled; ClickCount++; Invalidate();
      var handler = Pressed; if(handler != null) handler(this,e);
    }
  }
  public static class FrameIntegrity {
    public static uint CounterCrc32(uint counter) {
      uint crc=0xffffffffu;
      // IEEE CRC32 of the four little-endian counter bytes.
      for(int index=0;index<4;index++) {
        crc^=(counter>>(index*8))&0xffu;
        for(int bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1u)!=0?0xedb88320u:0u);
      }
      return crc^0xffffffffu;
    }
  }
  sealed class MotionCanvas : Control {
    public const int CounterBits=32, CounterCellWidth=8, CounterCellHeight=12, CounterX=20, CounterY=112;
    public long Frame, PaintCount, LastPaintTimestamp, LastPaintFrame;
    public long DistinctPaintFrames,FirstUniquePaintTimestamp,LastUniquePaintTimestamp;
    public readonly List<double> UniquePaintIntervals=new List<double>();
    public double ElapsedMilliseconds;
    public int FrameIntervalMilliseconds=33;
    public MotionCanvas() { DoubleBuffered = true; SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true); }
    protected override void OnPaint(PaintEventArgs e) {
      PaintCount++;long timestamp=Stopwatch.GetTimestamp();
      if(DistinctPaintFrames==0||LastPaintFrame!=Frame){
        if(LastUniquePaintTimestamp!=0&&UniquePaintIntervals.Count<2048)UniquePaintIntervals.Add((timestamp-LastUniquePaintTimestamp)*1000.0/Stopwatch.Frequency);
        if(DistinctPaintFrames==0)FirstUniquePaintTimestamp=timestamp;
        LastUniquePaintTimestamp=timestamp;DistinctPaintFrames++;
      }
      LastPaintTimestamp=timestamp;LastPaintFrame=Frame;
      e.Graphics.Clear(Color.FromArgb(12,18,30));
      int offset = (int)((Frame * 13) % 96);
      using(var stripe = new SolidBrush(Color.FromArgb(32,75,125))) {
        for(int x = offset - 96; x < Width; x += 96) e.Graphics.FillRectangle(stripe, x, 0, 36, Height);
      }
      int travel = Math.Max(1,Width-96), squareX = (int)((Frame*17) % travel);
      e.Graphics.FillRectangle(Brushes.Lime, squareX, Math.Max(0,Height-85), 72, 62);
      using(var font = new Font("Consolas", 28, FontStyle.Bold)) {
        e.Graphics.DrawString("FRAME " + Frame.ToString("D6"), font, Brushes.White, 18, 18);
      }
      using(var font = new Font("Consolas", 13)) {
        e.Graphics.DrawString(FrameIntervalMilliseconds + " ms guest animation | " + ElapsedMilliseconds.ToString("F0") + " ms", font, Brushes.White, 20, 75);
      }
      // Fixed, unaliased centers let native-pixel sampling count distinct guest
      // frames without interpreting text or counting repeated RDP paint events.
      uint counter=unchecked((uint)LastPaintFrame),checksum=FrameIntegrity.CounterCrc32(counter);
      using(var zero=new SolidBrush(Color.FromArgb(24,24,24)))
      using(var one=new SolidBrush(Color.FromArgb(245,245,245))) {
        for(int bit=0;bit<CounterBits;bit++) {
          e.Graphics.FillRectangle((counter & (1u<<bit))!=0 ? one : zero,
            CounterX+bit*CounterCellWidth,CounterY,CounterCellWidth,CounterCellHeight);
          e.Graphics.FillRectangle((checksum & (1u<<bit))!=0 ? one : zero,
            CounterX+bit*CounterCellWidth,CounterY+CounterCellHeight,CounterCellWidth,CounterCellHeight);
        }
      }
    }
  }
  sealed class MotionForm : Form {
    readonly string runId, outputPath, hostName;
    readonly int duration, guestSession, frameIntervalMilliseconds;
    readonly SnapshotWriter writer;
    readonly Stopwatch elapsed = new Stopwatch();
    readonly DeadlinePacer pacer;
    readonly MotionCanvas canvas = new MotionCanvas();
    readonly Marker left = new Marker("left"), right = new Marker("right");
    readonly List<object> clicks = new List<object>();
    readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    long tickCount, lastPublish;
    long coalescedUiTicks;
    int tickPosted;
    double lastTickMs;
    readonly List<double> tickIntervals=new List<double>();
    bool complete;
    readonly string startedAt = DateTime.UtcNow.ToString("o");
    public string FinalMetadata;
    public string WriterError { get { return writer.LastError; } }
    public bool FinalWritten {get{return writer.FinalWritten;}}
    public MotionForm(string id, string path, string host, int seconds, int session, int interval) {
      runId=id;outputPath=path;hostName=host;duration=seconds;guestSession=session;
      frameIntervalMilliseconds=MotionFixture.ValidateFrameIntervalMilliseconds(interval);
      canvas.FrameIntervalMilliseconds=frameIntervalMilliseconds;
      Text="BLACKICE guest native display test - " + id;
      StartPosition=FormStartPosition.Manual; FormBorderStyle=FormBorderStyle.FixedSingle;
      // This guarded fixture runs only inside the paired guest. Keep its own
      // markers above guest setup dialogs; the host renderer remains hidden.
      MaximizeBox=false;MinimizeBox=false;ShowInTaskbar=true;TopMost=true;BackColor=Color.FromArgb(12,18,30);
      Rectangle screen=Screen.PrimaryScreen.WorkingArea;
      if(screen.Width<640 || screen.Height<480) throw new InvalidOperationException("Guest desktop is too small for the fixture.");
      Location=new Point(screen.Left+12,screen.Top+12);
      ClientSize=new Size(Math.Min(960,screen.Width-32),Math.Min(620,screen.Height-80));
      var title=new Label { Text="Guest-only motion and input test", ForeColor=Color.White, BackColor=BackColor, Location=new Point(18,14), Size=new Size(ClientSize.Width-36,38), Font=new Font("Segoe UI",19,FontStyle.Bold) };
      var detail=new Label { Text="AMBER / CYAN markers - " + frameIntervalMilliseconds + " ms frame target - closes after " + duration + " seconds.", ForeColor=Color.Silver, Location=new Point(20,56), Size=new Size(ClientSize.Width-40,26) };
      int markerWidth=(ClientSize.Width-54)/2;
      left.Bounds=new Rectangle(18,94,markerWidth,132);right.Bounds=new Rectangle(36+markerWidth,94,markerWidth,132);
      canvas.Bounds=new Rectangle(18,242,ClientSize.Width-36,ClientSize.Height-260);
      Controls.Add(title);Controls.Add(detail);Controls.Add(left);Controls.Add(right);Controls.Add(canvas);
      left.Pressed+=MarkerPressed;right.Pressed+=MarkerPressed;
      writer=new SnapshotWriter(path);
      pacer=new DeadlinePacer(frameIntervalMilliseconds,()=>{
        if(Interlocked.CompareExchange(ref tickPosted,1,0)!=0){Interlocked.Increment(ref coalescedUiTicks);return;}
        try{BeginInvoke((Action)(()=>{Interlocked.Exchange(ref tickPosted,0);Tick();}));}
        catch(InvalidOperationException){Interlocked.Exchange(ref tickPosted,0);}
      });
      Shown+=(sender,args)=>{elapsed.Start();Publish("running");pacer.Start();};
      FormClosing+=(sender,args)=>{pacer.Dispose();complete=true;Publish("closed");};
      FormClosed+=(sender,args)=>{writer.Dispose();};
    }
    static object Rect(Rectangle rect) { return new { x=rect.X,y=rect.Y,width=rect.Width,height=rect.Height }; }
    object MarkerInfo(Marker marker) {
      Rectangle screen=marker.RectangleToScreen(marker.ClientRectangle);
      return new { id=marker.MarkerId,color=marker.ColorHex,toggled=marker.Toggled,clickCount=marker.ClickCount,
        clientBounds=Rect(marker.Bounds),screenBounds=Rect(screen),
        clickClientPoint=new {x=marker.Left+marker.Width/2,y=marker.Top+marker.Height/2},
        clickScreenPoint=new {x=screen.Left+screen.Width/2,y=screen.Top+screen.Height/2} };
    }
    object BinaryCounterInfo() {
      var points=new object[MotionCanvas.CounterBits*2];
      for(int index=0;index<points.Length;index++) {
        int rowIndex=index/MotionCanvas.CounterBits,bit=index%MotionCanvas.CounterBits;
        int x=MotionCanvas.CounterX+bit*MotionCanvas.CounterCellWidth+MotionCanvas.CounterCellWidth/2;
        int y=MotionCanvas.CounterY+rowIndex*MotionCanvas.CounterCellHeight+MotionCanvas.CounterCellHeight/2;
        Point screen=canvas.PointToScreen(new Point(x,y));
        points[index]=new {role=rowIndex==0?"counter":"checksum",bit=bit,screenPoint=new {x=screen.X,y=screen.Y},clientPoint=new {x=canvas.Left+x,y=canvas.Top+y}};
      }
      Rectangle row=new Rectangle(MotionCanvas.CounterX,MotionCanvas.CounterY,
        MotionCanvas.CounterBits*MotionCanvas.CounterCellWidth,MotionCanvas.CounterCellHeight*2);
      return new {bits=MotionCanvas.CounterBits,bitOrder="least-significant-first",valueType="uint32",
        cellWidth=MotionCanvas.CounterCellWidth,cellHeight=MotionCanvas.CounterCellHeight,
        zeroRgb=new {r=24,g=24,b=24},oneRgb=new {r=245,g=245,b=245},classificationThreshold=128,
        checksum=new {algorithm="crc32-ieee",inputEncoding="uint32-little-endian",bits=32,pointOffset=32,
          polynomial="0xEDB88320",initial="0xFFFFFFFF",xorOut="0xFFFFFFFF",bitOrder="least-significant-first"},
        lastPaintedValue=unchecked((uint)canvas.LastPaintFrame),lastPaintTimestamp=canvas.LastPaintTimestamp,
        canvasBounds=Rect(row),screenBounds=Rect(canvas.RectangleToScreen(row)),samplePoints=points};
    }
    void MarkerPressed(Marker marker,MouseEventArgs click) {
      Point screen=marker.PointToScreen(click.Location);
      if(clicks.Count<64) clicks.Add(new { marker=marker.MarkerId,clickCount=left.ClickCount+right.ClickCount,
        guestTimestamp=Stopwatch.GetTimestamp(),guestElapsedMilliseconds=elapsed.Elapsed.TotalMilliseconds,
        afterFrame=canvas.Frame,color=marker.ColorHex,clientPoint=new {x=marker.Left+click.X,y=marker.Top+click.Y},screenPoint=new {x=screen.X,y=screen.Y} });
      Publish("running");
    }
    void Tick() {
      if(complete)return;
      if(elapsed.Elapsed.TotalSeconds>=duration) { Close();return; }
      double now=elapsed.Elapsed.TotalMilliseconds;
      if(lastTickMs>0&&tickIntervals.Count<2048)tickIntervals.Add(now-lastTickMs);lastTickMs=now;
      tickCount++;canvas.Frame=DeadlinePacer.SlotForElapsed(now,frameIntervalMilliseconds);canvas.ElapsedMilliseconds=now;canvas.Invalidate();
      if(elapsed.ElapsedMilliseconds-lastPublish>=250) {lastPublish=elapsed.ElapsedMilliseconds;Publish("running");}
    }
    void Publish(string phase) {
      var metadata=new { format=1,fixture="blackice-native-motion",runId=runId,phase=phase,complete=complete,
        hostName=hostName,guestName=Environment.MachineName,guestSessionId=guestSession,processId=Process.GetCurrentProcess().Id,
        windowTitle=Text,startedAtUtc=startedAt,atUtc=DateTime.UtcNow.ToString("o"),durationSeconds=duration,
        clockDomain="guest Stopwatch",clockFrequency=Stopwatch.Frequency,guestTimestamp=Stopwatch.GetTimestamp(),guestElapsedMilliseconds=elapsed.Elapsed.TotalMilliseconds,
        timerIntervalMs=frameIntervalMilliseconds,tickCount=tickCount,paintCount=canvas.PaintCount,lastPaintTimestamp=canvas.LastPaintTimestamp,lastPaintFrame=canvas.LastPaintFrame,
        cadence=new {scheduler="Stopwatch absolute deadlines with coalesced UI posts",requestedIntervalMs=frameIntervalMilliseconds,targetFramesPerSecond=1000.0/frameIntervalMilliseconds,
          scheduledTicks=pacer.ScheduledTicks,skippedScheduleSlots=pacer.SkippedSlots,coalescedUiTicks=Interlocked.Read(ref coalescedUiTicks),
          tickIntervals=Cadence.Summary(tickIntervals),distinctPaintFrames=canvas.DistinctPaintFrames,
          uniquePaintIntervals=Cadence.Summary(canvas.UniquePaintIntervals),
          actualUniquePaintFramesPerSecond=canvas.LastUniquePaintTimestamp>canvas.FirstUniquePaintTimestamp?
            (canvas.DistinctPaintFrames-1)*Stopwatch.Frequency/(double)(canvas.LastUniquePaintTimestamp-canvas.FirstUniquePaintTimestamp):0},
        binaryFrameCounter=BinaryCounterInfo(),
        clickCount=left.ClickCount+right.ClickCount,windowBounds=Rect(Bounds),clientScreenBounds=Rect(RectangleToScreen(ClientRectangle)),
        guestScreenBounds=Rect(Screen.PrimaryScreen.Bounds),markers=new object[]{MarkerInfo(left),MarkerInfo(right)},clicks=clicks.ToArray(),
        metadataPath=outputPath,finalMetadataPath=writer.FinalDestination,metadataWrites=writer.Writes,metadataWriteError=writer.LastError };
      FinalMetadata=serializer.Serialize(metadata);writer.Publish(FinalMetadata,complete);
    }
    protected override void Dispose(bool disposing) {
      if(disposing) {pacer.Dispose();writer.Dispose();} base.Dispose(disposing);
    }
  }
  public static class MotionFixture {
    public static int ValidateFrameIntervalMilliseconds(int value) {
      if(value<8||value>100)throw new ArgumentOutOfRangeException("value","Frame interval must be 8 to 100 milliseconds.");
      return value;
    }
    public static string Run(string runId,string outputPath,string host,int seconds,int session) {
      return Run(runId,outputPath,host,seconds,session,33);
    }
    public static string Run(string runId,string outputPath,string host,int seconds,int session,int frameIntervalMilliseconds) {
      ValidateFrameIntervalMilliseconds(frameIntervalMilliseconds);
      Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
      using(var form=new MotionForm(runId,outputPath,host,seconds,session,frameIntervalMilliseconds)) {
        Application.Run(form);
        if(!form.FinalWritten)throw new IOException("Final fixture metadata was not published. "+form.WriterError);
        return form.FinalMetadata;
      }
    }
  }
}
'@

Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions
Add-Type -TypeDefinition $fixtureSource -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
New-Item -ItemType Directory -Force -Path $outputDirectory|Out-Null
[Blackice.GuestVerification.MotionFixture]::Run($RunId,$metadataPath,[string]$hostInfo.hostName,$DurationSeconds,$guestSessionId,$FrameIntervalMilliseconds)
