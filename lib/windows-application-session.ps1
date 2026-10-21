param([switch]$Stream,[int]$ParentProcessId)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$script:references = @{}
$script:launched = $false
$script:closed = $false

# No visible desktop is opened or switched. The fresh helper owns every native
# handle below; losing its pipe/process closes its kill-on-close process job.
$native = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BlackiceApplicationSession {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct BASIC_ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left,Top,Right,Bottom; }
    public class WindowInfo { public string id,title; public int pid; public bool isolated=true; public int x,y,width,height; }
    public class Frame { public string data,mimeType="image/png",method="print_window"; public int width,height,nativeWidth,nativeHeight; }
    public class OwnedProcessInfo { public int pid; public string role,state; public long firstSeenMs,lastObservedMs; public uint? exitCode; }
    public class LaunchDiagnostic {
        public int version=1,rootPid,observedProcessLimit=64,jobTotalProcesses=-1,jobActiveProcesses=-1,jobTerminatedProcesses=-1,unobservedProcessCount;
        public string windowStation="unknown",phase="initializing";
        public bool isolationVerified,processListTruncated,windowsTruncated,diagnosticsIncomplete,closed,terminationAttempted,terminationSucceeded,allObservedProcessesExited;
        public int jobQueryError,processQueryError,terminationError,enumerationError,privateWindows,ownedWindows,visibleOwnedWindows,hiddenOwnedWindows,unownedWindows,ownershipQueryFailures,windowGeometryFailures;
        public OwnedProcessInfo[] processes=new OwnedProcessInfo[0];
    }
    private class TrackedProcess { public int pid; public IntPtr handle; public bool launcher; public long firstSeenMs; }
    private delegate bool EnumDesktopProc(IntPtr hwnd, IntPtr unused);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateDesktopW(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr security);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll",SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",SetLastError=true)] private static extern bool DesktopInput(IntPtr desktop,int index,out int value,uint length,out uint needed);
    [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool DesktopName(IntPtr desktop,int index,StringBuilder value,uint length,out uint needed);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr information,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job,int informationClass,IntPtr information,uint size,out uint returned);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job,uint exitCode);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool TerminateProcess(IntPtr process,uint exitCode);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool EnumDesktopWindows(IntPtr desktop,EnumDesktopProc callback,IntPtr unused);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd,out RECT bounds);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd,StringBuilder title,int count);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
    private static IntPtr desktop,originalDesktop,job,rootProcess;
    private static string name;
    private static bool closed;
    private static readonly Dictionary<int,TrackedProcess> observed=new Dictionary<int,TrackedProcess>();
    private static readonly LaunchDiagnostic diagnostic=new LaunchDiagnostic();
    private static readonly Stopwatch lifetime=Stopwatch.StartNew();
    public static int RootPid { get; private set; }
    public static string LaunchState() { uint code; if(rootProcess==IntPtr.Zero || !GetExitCodeProcess(rootProcess,out code)) return "Launcher state unavailable."; return code==259 ? "The owned launcher is still running." : "The owned launcher exited with code "+code+"."; }
    private static bool watchingParent;
    private static void NativeError(string action) { int code=Marshal.GetLastWin32Error(); throw new Win32Exception(code, action+" (Win32 "+code+": "+new Win32Exception(code).Message+")"); }
    private static string Name(IntPtr value) {
        var text=new StringBuilder(256); uint needed;
        if (!DesktopName(value,2,text,(uint)(text.Capacity*2),out needed)) NativeError("Cannot verify the private desktop name.");
        return text.ToString();
    }
    private static void ReadJobAccounting() {
        if(job==IntPtr.Zero) return;
        IntPtr block=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BASIC_ACCOUNTING)));
        try {
            uint returned;
            if(QueryInformationJobObject(job,1,block,(uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)),out returned)) {
                var info=(BASIC_ACCOUNTING)Marshal.PtrToStructure(block,typeof(BASIC_ACCOUNTING));
                diagnostic.jobTotalProcesses=(int)Math.Min(info.TotalProcesses,Int32.MaxValue);
                diagnostic.jobActiveProcesses=(int)Math.Min(info.ActiveProcesses,Int32.MaxValue);
                diagnostic.jobTerminatedProcesses=(int)Math.Min(info.TotalTerminatedProcesses,Int32.MaxValue);
            } else diagnostic.jobQueryError=Marshal.GetLastWin32Error();
        } finally { Marshal.FreeHGlobal(block); }
    }
    private static void ObserveOwnedProcesses() {
        if(job==IntPtr.Zero || closed) return;
        ReadJobAccounting();
        const int capacity=128;
        int size=8+IntPtr.Size*capacity;
        IntPtr block=Marshal.AllocHGlobal(size);
        try {
            Marshal.WriteInt32(block,0,0); Marshal.WriteInt32(block,4,0); uint returned;
            if(!QueryInformationJobObject(job,3,block,(uint)size,out returned)) {
                int error=Marshal.GetLastWin32Error(); diagnostic.jobQueryError=error;
                if(error==234) diagnostic.processListTruncated=true;
                return;
            }
            int count=Marshal.ReadInt32(block,4);
            if(count<0 || count>capacity) { diagnostic.processListTruncated=true; return; }
            for(int index=0;index<count;index++) {
                long raw=Marshal.ReadIntPtr(block,8+index*IntPtr.Size).ToInt64();
                if(raw<1 || raw>Int32.MaxValue) continue;
                int pid=(int)raw; if(observed.ContainsKey(pid)) continue;
                if(observed.Count>=diagnostic.observedProcessLimit) { diagnostic.processListTruncated=true; continue; }
                // Retain only confirmed job members. The handle prevents PID
                // reuse from being mistaken for the original owned process.
                IntPtr process=OpenProcess(0x00101000,false,(uint)pid);
                if(process==IntPtr.Zero) { diagnostic.processQueryError=Marshal.GetLastWin32Error(); continue; }
                bool member; bool queried=IsProcessInJob(process,job,out member);
                if(!queried || !member) { if(!queried) diagnostic.processQueryError=Marshal.GetLastWin32Error(); CloseHandle(process); continue; }
                observed.Add(pid,new TrackedProcess { pid=pid,handle=process,launcher=false,firstSeenMs=lifetime.ElapsedMilliseconds });
            }
        } finally { Marshal.FreeHGlobal(block); }
    }
    private static void RefreshProcessStates() {
        var result=new List<OwnedProcessInfo>(); bool all=observed.Count>0;
        foreach(var item in observed.Values) {
            uint exit; uint wait=WaitForSingleObject(item.handle,0);
            bool hasExit=GetExitCodeProcess(item.handle,out exit);
            string state=wait==0 ? "exited" : wait==0x102 ? "running" : "unavailable";
            if(state!="exited") all=false;
            result.Add(new OwnedProcessInfo { pid=item.pid,role=item.launcher?"launcher":"descendant",state=state,firstSeenMs=item.firstSeenMs,lastObservedMs=lifetime.ElapsedMilliseconds,exitCode=state=="exited"&&hasExit?(uint?)exit:null });
        }
        diagnostic.rootPid=RootPid; diagnostic.processes=result.ToArray();
        diagnostic.unobservedProcessCount=Math.Max(0,diagnostic.jobTotalProcesses-observed.Count);
        diagnostic.allObservedProcessesExited=all;
    }
    public static LaunchDiagnostic Diagnostics() {
        if(!closed) { ObserveOwnedProcesses(); RefreshProcessStates(); }
        return diagnostic;
    }
    public static void WatchParent(int pid) {
        if(watchingParent || pid<1) throw new InvalidOperationException("A valid owning server process is required.");
        IntPtr parent=OpenProcess(0x00100000,false,(uint)pid);
        if(parent==IntPtr.Zero) NativeError("Cannot observe the owning server process lifetime.");
        watchingParent=true;
        var watcher=new Thread(delegate() {
            try { WaitForSingleObject(parent,0xffffffff); }
            finally {
                CloseHandle(parent);
                // The owning server died, even if its request thread is stuck in
                // a provider. Process exit closes the job's last private handle.
                Environment.Exit(0);
            }
        });
        watcher.IsBackground=true; watcher.Start();
    }
    public static void Initialize() {
        if (desktop!=IntPtr.Zero || closed) throw new InvalidOperationException("This helper cannot reuse an application desktop.");
        originalDesktop=GetThreadDesktop(GetCurrentThreadId());
        string station=Name(GetProcessWindowStation());
        diagnostic.windowStation=String.Equals(station,"WinSta0",StringComparison.OrdinalIgnoreCase)?"WinSta0":"other";
        if(diagnostic.windowStation!="WinSta0") throw new InvalidOperationException("The helper is not connected to the expected WinSta0 window station. No application was launched.");
        name="BLACKICE_"+Guid.NewGuid().ToString("N");
        // READOBJECTS|CREATEWINDOW|CREATEMENU|ENUMERATE|WRITEOBJECTS; specifically
        // omit DESKTOP_SWITCHDESKTOP. CreateDesktop assigns only this helper thread.
        desktop=CreateDesktopW(name,IntPtr.Zero,IntPtr.Zero,0,0x00c7,IntPtr.Zero);
        if(desktop==IntPtr.Zero) NativeError("Cannot create a private application desktop.");
        try {
            if(!SetThreadDesktop(desktop)) NativeError("Cannot bind the helper to its private desktop.");
            AssertIsolated();
            job=CreateJobObjectW(IntPtr.Zero,null);
            if(job==IntPtr.Zero) NativeError("Cannot create the owned application job.");
            var limits=new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags=0x2000;
            IntPtr block=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
            try { Marshal.StructureToPtr(limits,block,false); if(!SetInformationJobObject(job,9,block,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) NativeError("Cannot protect the owned application process lifetime."); }
            finally { Marshal.FreeHGlobal(block); }
            block=Marshal.AllocHGlobal(4);
            // Prevent creating/switching desktops, display/system setting changes,
            // logout and clipboard access. This is UI containment, not a sandbox.
            try { Marshal.WriteInt32(block,0xde); if(!SetInformationJobObject(job,4,block,4)) NativeError("Cannot establish application UI restrictions."); }
            finally { Marshal.FreeHGlobal(block); }
        } catch { Close(); throw; }
    }
    public static void AssertIsolated() {
        diagnostic.isolationVerified=false;
        if(closed || desktop==IntPtr.Zero || Name(GetThreadDesktop(GetCurrentThreadId()))!=name) throw new InvalidOperationException("The helper is no longer attached to its private application desktop.");
        int input; uint needed;
        if(!DesktopInput(desktop,6,out input,4,out needed)) NativeError("Cannot verify that the private desktop is inactive.");
        if(input!=0) throw new InvalidOperationException("The private application desktop unexpectedly receives user input. The session must close.");
        diagnostic.isolationVerified=true;
    }
    private static string Quote(string value) {
        var result=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); slashes=0; continue; }
            result.Append('\\',slashes); slashes=0; result.Append(c);
        }
        result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
    }
    public static void Launch(string executable,string[] arguments) {
        AssertIsolated();
        diagnostic.phase="launching";
        if(RootPid!=0 || rootProcess!=IntPtr.Zero) throw new InvalidOperationException("An application is already owned by this session.");
        if(String.IsNullOrEmpty(executable) || !Path.IsPathRooted(executable) || executable.StartsWith("\\\\") || !File.Exists(executable) || !executable.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("The launch target is not a regular local executable.");
        if((File.GetAttributes(executable)&FileAttributes.ReparsePoint)!=0) throw new ArgumentException("Executable aliases are not supported.");
        // Do not allow a singleton to hand off to a preexisting user process.
        foreach(var existing in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable))) {
            existing.Dispose(); throw new InvalidOperationException("This application already has a running process. Close it yourself or choose another verified application; existing user applications are never reused.");
        }
        var command=new StringBuilder(Quote(executable));
        foreach(string argument in arguments) command.Append(" ").Append(Quote(argument));
        var startup=new STARTUPINFO(); startup.cb=Marshal.SizeOf(typeof(STARTUPINFO)); startup.lpDesktop="WinSta0\\"+name; startup.dwFlags=1; startup.wShowWindow=4;
        PROCESS_INFORMATION process;
        if(!CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x00000004,IntPtr.Zero,Path.GetDirectoryName(executable),ref startup,out process)) NativeError("The application could not start on its private desktop.");
        bool admitted=false;
        try {
            if(!AssignProcessToJobObject(job,process.hProcess)) NativeError("The application could not be assigned to its owned process job; it was never resumed.");
            admitted=true; rootProcess=process.hProcess; RootPid=(int)process.dwProcessId;
            observed.Add(RootPid,new TrackedProcess { pid=RootPid,handle=rootProcess,launcher=true,firstSeenMs=lifetime.ElapsedMilliseconds });
            if(ResumeThread(process.hThread)==0xffffffff) NativeError("The isolated application could not be resumed.");
            diagnostic.phase="waiting-for-window";
        } catch { if(admitted) TerminateJobObject(job,1); else TerminateProcess(process.hProcess,1); if(rootProcess==IntPtr.Zero) CloseHandle(process.hProcess); throw; }
        finally { CloseHandle(process.hThread); }
    }
    public static bool OwnsProcess(int pid) {
        if(pid<1 || job==IntPtr.Zero || closed) return false;
        IntPtr process=OpenProcess(0x1000,false,(uint)pid);
        if(process==IntPtr.Zero) { diagnostic.ownershipQueryFailures++; return false; }
        try { bool member; bool queried=IsProcessInJob(process,job,out member); if(!queried) diagnostic.ownershipQueryFailures++; return queried && member; }
        finally { CloseHandle(process); }
    }
    public static WindowInfo[] Windows() {
        AssertIsolated(); var result=new List<WindowInfo>();
        ObserveOwnedProcesses();
        diagnostic.privateWindows=0; diagnostic.ownedWindows=0; diagnostic.visibleOwnedWindows=0; diagnostic.hiddenOwnedWindows=0; diagnostic.unownedWindows=0; diagnostic.windowGeometryFailures=0; diagnostic.windowsTruncated=false;
        SetLastError(0);
        bool enumerated=EnumDesktopWindows(desktop,delegate(IntPtr hwnd,IntPtr unused) {
            if(diagnostic.privateWindows>=2000) { diagnostic.windowsTruncated=true; return false; }
            diagnostic.privateWindows++;
            uint pid; GetWindowThreadProcessId(hwnd,out pid); if(!OwnsProcess((int)pid)) { diagnostic.unownedWindows++; return true; }
            diagnostic.ownedWindows++;
            if(!IsWindowVisible(hwnd)) { diagnostic.hiddenOwnedWindows++; return true; }
            diagnostic.visibleOwnedWindows++;
            var title=new StringBuilder(513); GetWindowTextW(hwnd,title,title.Capacity);
            RECT rect; if(!GetWindowRect(hwnd,out rect)) { diagnostic.windowGeometryFailures++; return true; }
            result.Add(new WindowInfo { id=hwnd.ToInt64().ToString(),title=title.ToString(),pid=(int)pid,x=rect.Left,y=rect.Top,width=rect.Right-rect.Left,height=rect.Bottom-rect.Top });
            return result.Count<200;
        },IntPtr.Zero);
        // A newly created desktop can have no windows yet. Windows reports zero
        // without an error in that case; it is valid while waiting for launch.
        if(!enumerated && result.Count<200 && !diagnostic.windowsTruncated && Marshal.GetLastWin32Error()!=0) { diagnostic.enumerationError=Marshal.GetLastWin32Error(); NativeError("Cannot enumerate the private application's windows."); }
        if(result.Count>0) diagnostic.phase="ready";
        RefreshProcessStates();
        return result.ToArray();
    }
    public static WindowInfo RequireWindow(string id) {
        AssertIsolated();
        foreach(var window in Windows()) if(window.id==id && OwnsProcess(window.pid)) return window;
        throw new InvalidOperationException("The window is not an owned visible window on this private application desktop. List this session's windows again.");
    }
    public static Frame Capture(string id,int maximumWidth,int maximumHeight) {
        var window=RequireWindow(id);
        if(window.width<1 || window.height<1 || window.width>12000 || window.height>12000 || (long)window.width*window.height>32000000) throw new InvalidOperationException("The private application window exceeds the capture limit.");
        if(maximumWidth<1 || maximumWidth>1280 || maximumHeight<1 || maximumHeight>900) throw new ArgumentException("Invalid frame dimensions.");
        double scale=Math.Min(1.0,Math.Min(maximumWidth/(double)window.width,maximumHeight/(double)window.height));
        int width=Math.Max(1,(int)Math.Floor(window.width*scale)),height=Math.Max(1,(int)Math.Floor(window.height*scale));
        using(var bitmap=new Bitmap(window.width,window.height,PixelFormat.Format24bppRgb)) {
            using(var graphics=Graphics.FromImage(bitmap)) {
                IntPtr dc=graphics.GetHdc();
                try { if(!PrintWindow(new IntPtr(Int64.Parse(id)),dc,2)) throw new InvalidOperationException("This application cannot render an invisible frame through PrintWindow. No visible-desktop fallback is available."); }
                finally { graphics.ReleaseHdc(dc); }
            }
            AssertIsolated(); RequireWindow(id);
            using(var resized=new Bitmap(width,height,PixelFormat.Format24bppRgb)) {
                using(var graphics=Graphics.FromImage(resized)) { graphics.InterpolationMode=InterpolationMode.HighQualityBicubic; graphics.DrawImage(bitmap,0,0,width,height); }
                using(var stream=new MemoryStream()) {
                    resized.Save(stream,ImageFormat.Png);
                    if(stream.Length>6000000) throw new InvalidOperationException("The private application frame exceeds the output limit.");
                    return new Frame { data=Convert.ToBase64String(stream.ToArray()),width=width,height=height,nativeWidth=window.width,nativeHeight=window.height };
                }
            }
        }
    }
    public static void Close() {
        if(closed) return;
        // Preserve a final bounded ledger before terminating only this job. No
        // process names, executable paths or private-window titles enter it.
        try { ObserveOwnedProcesses(); } catch { diagnostic.diagnosticsIncomplete=true; }
        if(job!=IntPtr.Zero) {
            diagnostic.terminationAttempted=true;
            diagnostic.terminationSucceeded=TerminateJobObject(job,0);
            if(!diagnostic.terminationSucceeded) diagnostic.terminationError=Marshal.GetLastWin32Error();
            long deadline=lifetime.ElapsedMilliseconds+1500;
            foreach(var item in observed.Values) { long remaining=deadline-lifetime.ElapsedMilliseconds; if(remaining<=0) break; WaitForSingleObject(item.handle,(uint)remaining); }
            try { ReadJobAccounting(); } catch { diagnostic.diagnosticsIncomplete=true; }
            CloseHandle(job); job=IntPtr.Zero;
        }
        try { RefreshProcessStates(); } catch { diagnostic.diagnosticsIncomplete=true; diagnostic.allObservedProcessesExited=false; }
        closed=true; diagnostic.closed=true;
        foreach(var item in observed.Values) if(!item.launcher) CloseHandle(item.handle);
        observed.Clear();
        if(rootProcess!=IntPtr.Zero) { CloseHandle(rootProcess); rootProcess=IntPtr.Zero; }
        // This only detaches the helper thread after application termination. It
        // never changes which desktop is visible. Process exit releases it if UIA
        // created a hook/window and Windows refuses reassociation.
        if(desktop!=IntPtr.Zero && originalDesktop!=IntPtr.Zero && SetThreadDesktop(originalDesktop)) { CloseDesktop(desktop); desktop=IntPtr.Zero; }
    }
}
'@

function Initialize-ApplicationSession {
    if (-not ('BlackiceApplicationSession' -as [type])) {
        Add-Type -AssemblyName System.Drawing
        Add-Type -TypeDefinition $native -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll')
        [BlackiceApplicationSession]::WatchParent($ParentProcessId)
        [BlackiceApplicationSession]::Initialize()
        # Initialize all automation providers only after the fresh helper thread
        # is associated with its owned, non-input desktop.
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        Add-Type -AssemblyName WindowsBase
        Add-Type -Path @((Join-Path $PSScriptRoot 'windows-native-uia.cs'),(Join-Path $PSScriptRoot 'windows-uia.cs')) -ReferencedAssemblies @(
            [System.Windows.Automation.AutomationElement].Assembly.Location,
            [System.Windows.Automation.AutomationPattern].Assembly.Location,
            [System.Windows.Rect].Assembly.Location,
            'System.dll','System.Core.dll'
        )
        [RelayDesktop]::EnableDpi()
    }
    [BlackiceApplicationSession]::AssertIsolated()
}

function Assert-ApplicationInteger($value,[long]$minimum,[long]$maximum,[string]$label) {
    if ($null -eq $value -or $value -is [bool] -or $value -is [string] -or [double]$value -ne [math]::Floor([double]$value) -or $value -lt $minimum -or $value -gt $maximum) { throw "Invalid $label." }
}

function Resolve-ApplicationRef([string]$ref) {
    if ($ref -notmatch '^uia_[a-f0-9]{12}_[1-9]\d{0,6}$' -or -not $script:references.ContainsKey($ref)) { throw 'Unknown isolated application ref. Inspect the owned window again.' }
    $entry = $script:references[$ref]
    $null = [BlackiceApplicationSession]::RequireWindow([string]$entry.windowId)
    if (-not [BlackiceApplicationSession]::OwnsProcess([int]$entry.processId)) { throw 'The accessibility control is no longer owned by this application session.' }
    return $entry
}

function Invoke-ApplicationSession([string]$raw) {
    $request=$null
    try {
        if ($script:closed) { throw 'The isolated application session is closed.' }
        if ($raw.Length -gt 100000) { throw 'The isolated application request exceeded its size limit.' }
        $request=$raw | ConvertFrom-Json
        Assert-ApplicationInteger $request.requestId 1 9007199254740991 'request identifier'
        $supported=@('launch','windows','screenshot','inspect','get_text','invoke','set_value','select','toggle','expand','collapse','scroll','scroll_into_view')
        if ($supported -notcontains $request.action) { throw 'Unsupported isolated application action. Physical input and visible desktop switching are unavailable.' }
        Initialize-ApplicationSession
        $result=@{ok=$true;requestId=$request.requestId;mode='private_desktop';isolated=$true;physicalInput=$false;requiresForeground=$false}
        if ($request.action -eq 'launch') {
            if ($script:launched) { throw 'This helper already owns an application.' }
            if ($request.executable -isnot [string] -or $request.executable.Length -gt 1024 -or $request.executable -notmatch '^[a-zA-Z]:\\.*\.exe$' -or $request.executable -match '["\r\n\x00]' -or $request.executable -match '\\WindowsApps\\') { throw 'Invalid local executable path.' }
            if ($request.args -isnot [array] -or $request.args.Count -gt 32) { throw 'Application arguments must be a bounded array of literal strings.' }
            foreach ($argument in $request.args) { if ($argument -isnot [string] -or $argument.Length -gt 4096 -or $argument -match '[\r\n\x00]') { throw 'Invalid literal application argument.' } }
            [BlackiceApplicationSession]::Launch($request.executable,[string[]]$request.args)
            $script:launched=$true
            $deadline=[DateTime]::UtcNow.AddSeconds(15)
            do { $windows=@([BlackiceApplicationSession]::Windows()); if ($windows.Count -gt 0) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)
            if ($windows.Count -eq 0) { throw ('The application did not create an owned window on its private desktop within 15 seconds. '+[BlackiceApplicationSession]::LaunchState()+' Its private session was closed. This app may require a separate Windows session or VM.') }
            $result.pid=[BlackiceApplicationSession]::RootPid; $result.windows=$windows
            $result.text='Opened the application on an owned inactive desktop. Only its captured frames and accessibility controls are exposed inside BLACKICE.'
        } else {
            if (-not $script:launched) { throw 'Open a verified application in this session first.' }
            if ($null -ne $request.windowId -and ($request.windowId -isnot [string] -or $request.windowId -notmatch '^[1-9]\d{0,18}$')) { throw 'Invalid owned application window identifier.' }
            if ($request.windowId -and $request.ref) { throw 'Choose a windowId or accessibility ref, not both.' }
            switch ($request.action) {
                'windows' { $result.windows=@([BlackiceApplicationSession]::Windows()); $result.text='Listed owned windows on the inactive private application desktop.' }
                'screenshot' {
                    Assert-ApplicationInteger $request.maxWidth 1 1280 'frame width'; Assert-ApplicationInteger $request.maxHeight 1 900 'frame height'
                    $target=$request.windowId
                    if (-not $target) { $windows=@([BlackiceApplicationSession]::Windows()); if ($windows.Count -eq 0) { throw 'The private application has no owned visible window.' }; $target=$windows[0].id }
                    $frame=[BlackiceApplicationSession]::Capture([string]$target,[int]$request.maxWidth,[int]$request.maxHeight)
                    $result.image=@{mimeType=$frame.mimeType;data=$frame.data;width=$frame.width;height=$frame.height}
                    $result.windowId=$target; $result.method=$frame.method
                    $result.coordinates=@{width=$frame.width;height=$frame.height;nativeWidth=$frame.nativeWidth;nativeHeight=$frame.nativeHeight}
                    $result.text='Captured the owned application through PrintWindow. No visible desktop capture, activation or physical input was used.'
                }
                'inspect' {
                    Assert-ApplicationInteger $request.maxDepth 0 10 'inspection depth'; Assert-ApplicationInteger $request.maxNodes 1 300 'inspection size'
                    if ($request.query -isnot [string] -or $request.query.Length -gt 200 -or $request.query.Contains([char]0)) { throw 'Invalid inspection query.' }
                    if ($request.ref) { $entry=Resolve-ApplicationRef([string]$request.ref); $target=[string]$entry.windowId }
                    else { $target=[string]$request.windowId; $null=[BlackiceApplicationSession]::RequireWindow($target) }
                    $inspection=[RelayDesktop]::Inspect($(if($request.ref){''}else{$target}),[string]$request.ref,[int]$request.maxDepth,[int]$request.maxNodes,[string]$request.query)
                    $null=[BlackiceApplicationSession]::RequireWindow($target)
                    $elements=@($inspection.elements | Where-Object { [BlackiceApplicationSession]::OwnsProcess([int]$_.processId) })
                    foreach ($element in $elements) { $script:references[[string]$element.ref]=@{windowId=$target;processId=[int]$element.processId} }
                    if ($script:references.Count -gt 5000) { $script:references.Clear(); foreach ($element in $elements) { $script:references[[string]$element.ref]=@{windowId=$target;processId=[int]$element.processId} } }
                    $result.windowId=$target; $result.rootRef=$inspection.rootRef; $result.elements=$elements; $result.visited=$inspection.visited; $result.truncated=$inspection.truncated
                    $result.text='Inspected accessibility controls belonging to this private application session. Use only their advertised actions.'
                }
                'get_text' {
                    $null=Resolve-ApplicationRef([string]$request.ref)
                    Assert-ApplicationInteger $request.maxCharacters 1 12000 'text length'
                    $result.text=[RelayDesktop]::ReadText([string]$request.ref,[int]$request.maxCharacters); $result.ref=$request.ref
                }
                default {
                    $null=Resolve-ApplicationRef([string]$request.ref)
                    if ($request.action -eq 'set_value' -and (($request.value -isnot [string] -and $request.value -isnot [ValueType]) -or [string]$request.value -match '\x00' -or ([string]$request.value).Length -gt 10000)) { throw 'Invalid application field value.' }
                    if ($request.action -eq 'scroll') { if (@('up','down','left','right') -notcontains $request.direction -or @('small','large') -notcontains $request.unit) { throw 'Invalid application scroll direction or unit.' }; Assert-ApplicationInteger $request.amount 1 10 'scroll amount' }
                    [RelayDesktop]::Act([string]$request.action,[string]$request.ref,[string]$request.value,[string]$request.direction,[int]$request.amount,[string]$request.unit)
                    $result.ref=$request.ref; $result.mechanism=[RelayDesktop]::LastActionMechanism
                    $result.text='Completed the advertised semantic control action inside the private application desktop. Inspect the result before repeating an action.'
                }
            }
        }
        [BlackiceApplicationSession]::AssertIsolated()
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 14 -Compress))
    } catch {
        # Every admitted native failure is terminal. This avoids reusing uncertain
        # process ownership or a UIA provider that stopped responding.
        $script:closed=$true
        if ('BlackiceApplicationSession' -as [type]) { [BlackiceApplicationSession]::Close() }
        $failure=@{ok=$false;requestId=$request.requestId;error=$_.Exception.Message}
        if ('BlackiceApplicationSession' -as [type]) { $failure.diagnostics=[BlackiceApplicationSession]::Diagnostics() }
        [Console]::Out.WriteLine(($failure | ConvertTo-Json -Depth 6 -Compress))
    }
}

try {
    if ($Stream) { while ($null -ne ($line=[Console]::In.ReadLine())) { Invoke-ApplicationSession $line; if ($script:closed) { break } } }
    else { Invoke-ApplicationSession ([Console]::In.ReadToEnd()) }
} finally { if ('BlackiceApplicationSession' -as [type]) { [BlackiceApplicationSession]::Close() } }
