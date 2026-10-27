using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BlackiceNativeWindowHost {
    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    public class WindowInfo { public string id, title, process, processPath, processStartedAt, appId, parentWindowId, ownerWindowId, className, presentation, containerWindowId, hostWindowId; public int pid; public bool launchDescendant, contained, ownerVisible, toolWindow, appWindow, clipped, presented, ownershipVerified; public Rect bounds, visibleBounds, regionBounds; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry {
        public uint dwSize, cntUsage, th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    public class HostInfo {
        public bool attached, visible, embedded, sessionActive, recovering, isolated = false;
        public string windowId, title, mode = "native_window", reason, containerWindowId, parentWindowId, hostWindowId, containerParentWindowId;
        public string sessionId, sessionProcessStartedAt, lastTransition;
        public string[] windowIds;
        public int dialogCount, sessionPid, transitionCount;
        public Rect stageBounds, windowBounds, visibleBounds;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct WindowClass {
        public uint size,style;public WindowProcedure procedure;public int classExtra,windowExtra;public IntPtr instance,icon,cursor,background;public string menuName,className;public IntPtr smallIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Message {public IntPtr hwnd;public uint message;public UIntPtr wParam;public IntPtr lParam;public uint time;public Point point;public uint privateValue;}
    [StructLayout(LayoutKind.Sequential)] private struct ScrollInfo {public uint size,mask;public int min,max;public uint page;public int position,trackPosition;}
    private delegate IntPtr WindowProcedure(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct PropertyKey {public Guid format;public uint id;}
    [StructLayout(LayoutKind.Explicit,Size=24)] private struct PropertyValue {[FieldOffset(0)]public ushort type;[FieldOffset(8)]public IntPtr pointer;}
    [ComImport,Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface PropertyStore {
        [PreserveSig]int GetCount(out uint count);[PreserveSig]int GetAt(uint index,out PropertyKey key);[PreserveSig]int GetValue(ref PropertyKey key,out PropertyValue value);[PreserveSig]int SetValue(ref PropertyKey key,ref PropertyValue value);[PreserveSig]int Commit();
    }
    private delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent,WindowCallback callback,IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder buffer, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder buffer, int capacity);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
    [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] private static extern int SetWindowLongW(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern int SetThreadDpiHostingBehavior(int behavior);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern ushort RegisterClassExW(ref WindowClass value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateWindowExW(uint extendedStyle,string className,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessageW(out Message value,IntPtr hwnd,uint min,uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message value);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref Message value);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern UIntPtr SetTimer(IntPtr hwnd,UIntPtr id,uint milliseconds,IntPtr callback);
    [DllImport("user32.dll")] private static extern bool ShowScrollBar(IntPtr hwnd,int bar,bool show);
    [DllImport("user32.dll")] private static extern int SetScrollInfo(IntPtr hwnd,int bar,ref ScrollInfo value,bool redraw);
    [DllImport("user32.dll")] private static extern bool GetScrollInfo(IntPtr hwnd,int bar,ref ScrollInfo value);
    [DllImport("gdi32.dll")] private static extern IntPtr GetStockObject(int value);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left,int top,int right,int bottom);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr target,IntPtr first,IntPtr second,int mode);
    [DllImport("gdi32.dll")] private static extern int GetRgnBox(IntPtr region,out Rect bounds);
    [DllImport("gdi32.dll")] private static extern bool EqualRgn(IntPtr first,IntPtr second);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")] private static extern int GetWindowRgn(IntPtr hwnd,IntPtr region);
    [DllImport("user32.dll",SetLastError=true)] private static extern int SetWindowRgn(IntPtr hwnd,IntPtr region,bool redraw);
    [DllImport("shell32.dll",PreserveSig=true)] private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd,ref Guid id,[MarshalAs(UnmanagedType.Interface)]out PropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropertyValue value);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetLastActivePopup(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);

    private const int WS_CHILD = 0x40000000, WS_CAPTION = 0x00c00000, WS_THICKFRAME = 0x00040000;
    private const int WS_POPUP = unchecked((int)0x80000000);
    private static IntPtr appWindow, blackiceWindow, containerWindow;
    private static Rect stage;
    private static bool visible = true;
    private static string modeReason;
    private class ProcessLifetime {public IntPtr handle;public uint pid;public long started;}
    private class HostedWindow {public IntPtr handle,parent,owner,originalRegion,releaseRegion;public int style,sequence;public Rect bounds,appliedRegion;public bool wasVisible,managedModal,regionApplied,releasePrepared;public uint pid;public long started;public ProcessLifetime lifetime;}
    private static readonly Dictionary<uint,ProcessLifetime> processLifetimes=new Dictionary<uint,ProcessLifetime>();
    private static ProcessLifetime sessionLifetime;
    private static int dialogSequence;
    private static readonly Dictionary<long, HostedWindow> dialogs = new Dictionary<long, HostedWindow>();
    private static readonly Dictionary<long, HostedWindow> documents = new Dictionary<long, HostedWindow>();
    private static readonly HashSet<long> preexistingWindows=new HashSet<long>();
    private static readonly Dictionary<long,Rect> requestedLayouts=new Dictionary<long,Rect>();
    private static uint sessionPid;
    private static long sessionStarted;
    private static string sessionId,lastTransition;
    private static int transitionCount;
    private static bool refreshingSession;
    private static long lastSessionScan;
    private class PaintingClip {public IntPtr handle,parent;public uint pid;public int added;}
    private static readonly Dictionary<long,PaintingClip> paintingClips=new Dictionary<long,PaintingClip>();
    private static readonly object gate=new object();
    private static readonly WindowProcedure windowProcedure=ContainerProcedure;
    private static Thread containerThread;
    private static int scrollX,scrollY;
    private static IntPtr scrollWindow;

    static BlackiceNativeWindowHost() {
        // Panel coordinates are physical pixels, independent of the worker's DPI.
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
    }
    public static int ChangeOwnerIfNeeded(IntPtr owner,Func<bool> valid,Func<IntPtr> current,Func<IntPtr,int> change) {
        if(!valid())return 1400;
        if(current()==owner)return 0;
        int error=change(owner);
        if(!valid())return error==0?1400:error;
        // A zero previous owner is also the success return value. The actual
        // postcondition is authoritative, including callbacks inside User32.
        return current()==owner?0:error==0?31:error;
    }
    private static void SetOwner(IntPtr hwnd, IntPtr owner) {
        int error=ChangeOwnerIfNeeded(owner,delegate(){return IsWindow(hwnd);},delegate(){return GetWindow(hwnd,4);},delegate(IntPtr desired){
            SetLastError(0);
            if(IntPtr.Size==8)SetWindowLongPtr64(hwnd,-8,desired);else SetWindowLongW(hwnd,-8,desired.ToInt32());
            return Marshal.GetLastWin32Error();
        });
        if(error!=0)throw WindowError("set_owner:"+owner.ToInt64(),hwnd,error);
    }
    private static void SetStyle(IntPtr hwnd, int style) {
        if(IsWindow(hwnd)&&GetWindowLongW(hwnd,-16)==style)return;
        SetLastError(0);
        int prior = SetWindowLongW(hwnd, -16, style);
        int error=Marshal.GetLastWin32Error();if (prior == 0 && error != 0) throw WindowError("set_style:"+unchecked((uint)style).ToString("X8"),hwnd,error);
    }
    private static Win32Exception WindowError(string operation,IntPtr hwnd,int error) {uint pid;GetWindowThreadProcessId(hwnd,out pid);var name=new StringBuilder(128);GetClassNameW(hwnd,name,name.Capacity);return new Win32Exception(error,"Native window "+operation+" failed (Win32="+error+", hwnd="+hwnd.ToInt64()+", pid="+pid+", class="+name+", exists="+IsWindow(hwnd)+", parent="+GetParent(hwnd).ToInt64()+", owner="+GetWindow(hwnd,4).ToInt64()+"). "+new Win32Exception(error).Message);}

    private static IntPtr Parse(string value) {
        long handle;
        if (!long.TryParse(value, out handle) || handle <= 0 || !IsWindow(new IntPtr(handle)))
            throw new ArgumentException("Choose a currently visible application window.");
        return new IntPtr(handle);
    }
    private static string Title(IntPtr hwnd) {
        var buffer = new StringBuilder(512);
        GetWindowTextW(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }
    private static string ApplicationId(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "";
        try {
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) != 122 || length < 1 || length > 4096) return "";
            var value = new StringBuilder((int)length);
            return GetApplicationUserModelId(process, ref length, value) == 0 ? value.ToString() : "";
        } catch (EntryPointNotFoundException) { return ""; }
        finally { CloseHandle(process); }
    }
    private static string WindowApplicationId(IntPtr hwnd,uint pid) {
        PropertyStore store=null;var value=new PropertyValue();
        try {var id=new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");if(SHGetPropertyStoreForWindow(hwnd,ref id,out store)==0&&store!=null){var key=new PropertyKey {format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),id=5};if(store.GetValue(ref key,out value)==0&&value.type==31&&value.pointer!=IntPtr.Zero){string result=Marshal.PtrToStringUni(value.pointer);if(!String.IsNullOrWhiteSpace(result))return result;}}}
        catch(COMException){}catch(EntryPointNotFoundException){}finally{PropVariantClear(ref value);if(store!=null)Marshal.ReleaseComObject(store);}
        return ApplicationId(pid);
    }
    private static HashSet<uint> LaunchProcesses(int root) {
        var result = new HashSet<uint>();
        if (root <= 0) return result;
        result.Add((uint)root);
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return result;
        try {
            var parents = new Dictionary<uint, uint>();
            var entry = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32FirstW(snapshot, ref entry)) do { parents[entry.th32ProcessID] = entry.th32ParentProcessID; } while (Process32NextW(snapshot, ref entry));
            bool changed;
            do {
                changed = false;
                foreach (var process in parents) if (!result.Contains(process.Key) && result.Contains(process.Value)) { result.Add(process.Key); changed = true; }
            } while (changed);
        } finally { CloseHandle(snapshot); }
        return result;
    }
    // A freshly created Excel workbook is initially hidden, and must be fully
    // initialized before changing the parent of Excel's native XLMAIN window.
    // Only the helper that owns the COM startup may surface this exact HWND.
    public static WindowInfo PreparedExcelWindow(string id) {
        IntPtr hwnd=Parse(id);
        uint pid;GetWindowThreadProcessId(hwnd,out pid);
        if(pid==0)throw new InvalidOperationException("The prepared Excel window has no process.");
        var classname=new StringBuilder(128);GetClassNameW(hwnd,classname,classname.Capacity);
        if(classname.ToString()!="XLMAIN")throw new InvalidOperationException("The prepared Excel handle is not an XLMAIN window.");
        using(var process=Process.GetProcessById((int)pid)){
            if(!String.Equals(process.ProcessName,"EXCEL",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("The prepared window is not Excel.");
            return new WindowInfo{id=hwnd.ToInt64().ToString(),title=Title(hwnd),className=classname.ToString(),pid=(int)pid,
                process=process.ProcessName,processPath=process.MainModule.FileName,processStartedAt=process.StartTime.ToUniversalTime().ToString("O"),appWindow=true};
        }
    }
    public static WindowInfo[] Windows(int excludedPid, int launchPid) {
        var result = new List<WindowInfo>();
        var launched = LaunchProcesses(launchPid);
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (!IsWindowVisible(hwnd) || hwnd == blackiceWindow) return true;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0 || pid == excludedPid || pid == Process.GetCurrentProcess().Id) return true;
            Rect area;
            if (!GetWindowRect(hwnd, out area) || area.Width < 64 || area.Height < 40) return true;
            var classname = new StringBuilder(128);
            GetClassNameW(hwnd, classname, classname.Capacity);
            if (classname.ToString() == "Progman" || classname.ToString() == "WorkerW" || classname.ToString() == "Shell_TrayWnd") return true;
            string title = Title(hwnd);
            if (String.IsNullOrWhiteSpace(title)) return true;
            string process = "Application", processPath = "", processStartedAt=null;
            try { using (var candidate = Process.GetProcessById((int)pid)) { process = candidate.ProcessName; try { processPath = candidate.MainModule.FileName; } catch {} try{processStartedAt=candidate.StartTime.ToUniversalTime().ToString("O");}catch{} } } catch {}
            IntPtr owner=GetWindow(hwnd,4);int extended=GetWindowLongW(hwnd,-20);
            result.Add(new WindowInfo { id = hwnd.ToInt64().ToString(), title = title, process = process, processPath = processPath, processStartedAt=processStartedAt,appId = WindowApplicationId(hwnd,pid), pid = (int)pid, launchDescendant = launched.Contains(pid),ownerWindowId=owner==IntPtr.Zero?null:owner.ToInt64().ToString(),ownerVisible=owner!=IntPtr.Zero&&IsWindowVisible(owner),toolWindow=(extended&0x80)!=0,appWindow=(extended&0x40000)!=0,className=classname.ToString() });
            return result.Count < 120;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    private static Rect WindowBounds(IntPtr hwnd) {Rect result;return GetWindowRect(hwnd,out result)?result:new Rect();}
    private static Rect StageClientBounds() {Rect client;if(containerWindow==IntPtr.Zero||!GetClientRect(containerWindow,out client))return new Rect();var point=new Point();if(!ClientToScreen(containerWindow,ref point))return new Rect();return new Rect {Left=point.X,Top=point.Y,Right=point.X+client.Width,Bottom=point.Y+client.Height};}
    private static bool SameRect(Rect first,Rect second) {return first.Left==second.Left&&first.Top==second.Top&&first.Right==second.Right&&first.Bottom==second.Bottom;}
    private static Rect Intersection(Rect first,Rect second) {return new Rect {Left=Math.Max(first.Left,second.Left),Top=Math.Max(first.Top,second.Top),Right=Math.Max(Math.Max(first.Left,second.Left),Math.Min(first.Right,second.Right)),Bottom=Math.Max(Math.Max(first.Top,second.Top),Math.Min(first.Bottom,second.Bottom))};}
    private static bool LifetimeAlive(ProcessLifetime lifetime) {return lifetime!=null&&lifetime.handle!=IntPtr.Zero&&WaitForSingleObject(lifetime.handle,0)==258;}
    private static ProcessLifetime RememberProcess(uint pid) {
        ProcessLifetime lifetime;if(processLifetimes.TryGetValue(pid,out lifetime)&&LifetimeAlive(lifetime))return lifetime;
        if(lifetime!=null&&lifetime.handle!=IntPtr.Zero){CloseHandle(lifetime.handle);lifetime.handle=IntPtr.Zero;}
        // Keep a handle to this exact process lifetime. A zero-time exit check
        // cannot mistake a reused PID for the session, and needs no repeated
        // process/path/signature query while monitoring document transitions.
        IntPtr handle=OpenProcess(0x00101000,false,pid);long created,exited,kernel,user;
        if(handle==IntPtr.Zero||!GetProcessTimes(handle,out created,out exited,out kernel,out user)){if(handle!=IntPtr.Zero)CloseHandle(handle);throw new InvalidOperationException("The application process lifetime could not be identified.");}
        lifetime=new ProcessLifetime {handle=handle,pid=pid,started=DateTime.FromFileTimeUtc(created).Ticks};processLifetimes[pid]=lifetime;return lifetime;
    }
    private static bool SessionAlive() {return sessionId!=null&&LifetimeAlive(sessionLifetime);}
    private static bool SameWindow(HostedWindow window) {if(!IsWindow(window.handle)||!LifetimeAlive(window.lifetime))return false;uint pid;GetWindowThreadProcessId(window.handle,out pid);return pid==window.pid;}
    private static HostedWindow RememberWindow(IntPtr hwnd) {uint pid;GetWindowThreadProcessId(hwnd,out pid);var lifetime=RememberProcess(pid);return new HostedWindow {handle=hwnd,parent=IntPtr.Zero,owner=GetWindow(hwnd,4),style=GetWindowLongW(hwnd,-16),bounds=WindowBounds(hwnd),wasVisible=IsWindowVisible(hwnd),sequence=++dialogSequence,pid=pid,started=lifetime.started,lifetime=lifetime};}
    private static void Transition(string kind) {lastTransition=kind;transitionCount++;}
    private static bool IsEmbedded() {return appWindow!=IntPtr.Zero&&IsWindow(appWindow)&&(GetWindowLongW(appWindow,-16)&WS_CHILD)!=0&&containerWindow!=IntPtr.Zero&&IsWindow(containerWindow)&&GetParent(appWindow)==containerWindow&&GetParent(containerWindow)==blackiceWindow;}
    private static void ClipPainting(IntPtr hwnd,int flags) {
        int style=GetWindowLongW(hwnd,-16),added=flags&~style;if(added==0)return;
        PaintingClip saved;if(!paintingClips.TryGetValue(hwnd.ToInt64(),out saved)){uint pid;GetWindowThreadProcessId(hwnd,out pid);saved=new PaintingClip {handle=hwnd,parent=GetParent(hwnd),pid=pid};paintingClips[hwnd.ToInt64()]=saved;}
        SetStyle(hwnd,style|flags);saved.added|=added;
    }
    private static void ProtectHostPainting() {
        if(blackiceWindow==IntPtr.Zero||!IsWindow(blackiceWindow))return;
        // The Electron parent must exclude its children from background paint,
        // and Chromium's overlapping children must respect sibling clipping.
        // These flags belong only to BLACKICE's own root/direct render children.
        ClipPainting(blackiceWindow,0x02000000);
        EnumChildWindows(blackiceWindow,delegate(IntPtr hwnd,IntPtr unused){if(hwnd!=containerWindow&&GetParent(hwnd)==blackiceWindow)ClipPainting(hwnd,0x04000000);return true;},IntPtr.Zero);
    }
    private static void RestoreHostPainting() {
        foreach(var saved in paintingClips.Values){if(!IsWindow(saved.handle))continue;uint pid;GetWindowThreadProcessId(saved.handle,out pid);if(pid!=saved.pid||GetParent(saved.handle)!=saved.parent)continue;try{SetStyle(saved.handle,GetWindowLongW(saved.handle,-16)&~saved.added);}catch(Win32Exception){}}
        paintingClips.Clear();
    }
    private static void RaiseChild(IntPtr child,IntPtr parent) {
        // Chromium has native rendering children of the same Electron HWND.
        // HWND_TOP here changes only this verified child's sibling order; it
        // never raises BLACKICE among desktop windows or activates either app.
        if(child!=IntPtr.Zero&&parent!=IntPtr.Zero&&IsWindow(child)&&IsWindowVisible(child)
            &&GetParent(child)==parent&&(GetWindowLongW(child,-16)&WS_CHILD)!=0)
            SetWindowPos(child,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0010|0x0200);
    }
    private static void RaiseChildStage() {if(visible){ProtectHostPainting();RaiseChild(containerWindow,blackiceWindow);}}
    private static int DialogDepth(HostedWindow window) {int depth=0;HostedWindow owner;IntPtr next=window.owner;while(depth<64&&dialogs.TryGetValue(next.ToInt64(),out owner)){depth++;next=owner.owner;}return depth;}
    private static void RaiseDialogs() {var ordered=new List<HostedWindow>(dialogs.Values);ordered.Sort(delegate(HostedWindow first,HostedWindow second){int depth=DialogDepth(first).CompareTo(DialogDepth(second));return depth!=0?depth:first.sequence.CompareTo(second.sequence);});foreach(var popup in ordered)if(!popup.managedModal)RaiseChild(popup.handle,containerWindow);}
    public static HostInfo Status() {lock(gate){
        RefreshSession();
        bool attached=IsEmbedded();Rect bounds=attached?WindowBounds(appWindow):new Rect(),clip=attached?WindowBounds(containerWindow):new Rect();
        return new HostInfo {attached=attached,embedded=attached,visible=attached&&visible&&IsWindowVisible(containerWindow),windowId=attached?appWindow.ToInt64().ToString():null,title=attached?Title(appWindow):"",dialogCount=dialogs.Count,containerWindowId=containerWindow!=IntPtr.Zero?containerWindow.ToInt64().ToString():null,parentWindowId=attached?GetParent(appWindow).ToInt64().ToString():null,hostWindowId=blackiceWindow!=IntPtr.Zero?blackiceWindow.ToInt64().ToString():null,containerParentWindowId=containerWindow!=IntPtr.Zero&&IsWindow(containerWindow)?GetParent(containerWindow).ToInt64().ToString():null,stageBounds=stage,windowBounds=bounds,visibleBounds=Intersection(bounds,clip),reason=modeReason,sessionActive=sessionId!=null,recovering=sessionId!=null&&!attached,sessionId=sessionId,sessionPid=(int)sessionPid,sessionProcessStartedAt=sessionStarted==0?null:new DateTime(sessionStarted,DateTimeKind.Utc).ToString("O"),windowIds=new List<long>(documents.Keys).ConvertAll(value=>value.ToString()).ToArray(),lastTransition=lastTransition,transitionCount=transitionCount};
    }}
    private static void ValidateBounds(IntPtr host,int x,int y,int width,int height) {
        Rect client;if(!GetClientRect(host,out client))throw new Win32Exception(Marshal.GetLastWin32Error());
        if(x<0||y<0||width<80||height<60||width>10000||height>10000||x+width>client.Width+4||y+height>client.Height+4)throw new ArgumentException("Application bounds must remain inside BLACKICE.");
    }
    private static IntPtr ContainerProcedure(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam) {
        if(message==0x0002){PostQuitMessage(0);return IntPtr.Zero;}
        if(message==0x0113&&Monitor.TryEnter(gate))try{RefreshSession();if(IsEmbedded()){LayoutWindows();RaiseChildStage();}}catch(Exception error){modeReason="Application window manager: "+error.Message;}finally{Monitor.Exit(gate);}
        if((message==0x0114||message==0x0115)&&Monitor.TryEnter(gate))try{
            int bar=message==0x0114?0:1,code=(int)(wParam.ToUInt64()&0xffff);var info=new ScrollInfo {size=(uint)Marshal.SizeOf(typeof(ScrollInfo)),mask=0x17};GetScrollInfo(hwnd,bar,ref info);
            int position=bar==0?scrollX:scrollY;
            if(code==0)position-=30;else if(code==1)position+=30;else if(code==2)position-=(int)info.page;else if(code==3)position+=(int)info.page;else if(code==4||code==5)position=info.trackPosition;else if(code==6)position=0;else if(code==7)position=info.max;
            position=Math.Max(0,Math.Min(position,Math.Max(0,info.max-(int)info.page+1)));if(bar==0)scrollX=position;else scrollY=position;LayoutWindows();return IntPtr.Zero;
        }finally{Monitor.Exit(gate);}
        return DefWindowProcW(hwnd,message,wParam,lParam);
    }
    private static void CreateContainer(IntPtr parent,int x,int y,int width,int height) {
        Exception failure=null;var ready=new ManualResetEvent(false);
        containerThread=new Thread(delegate(){try{
            try{SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(parent));SetThreadDpiHostingBehavior(1);}catch(EntryPointNotFoundException){}
            string name="BlackiceApplicationStage_"+Process.GetCurrentProcess().Id+"_"+Guid.NewGuid().ToString("N");
            var value=new WindowClass {size=(uint)Marshal.SizeOf(typeof(WindowClass)),procedure=windowProcedure,className=name,background=GetStockObject(4)};
            if(RegisterClassExW(ref value)==0)throw new Win32Exception(Marshal.GetLastWin32Error());
            // Create hidden. Attachment explicitly shows the completed child
            // stage with SW_SHOWNA; creation must not activate its host.
            containerWindow=CreateWindowExW(0,name,"BLACKICE application stage",0x40000000|0x02000000|0x04000000|0x00100000|0x00200000,x,y,width,height,parent,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
            if(containerWindow==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            ShowScrollBar(containerWindow,3,false);SetTimer(containerWindow,new UIntPtr(1),250,IntPtr.Zero);ready.Set();
            Message message;while(GetMessageW(out message,IntPtr.Zero,0,0)>0){TranslateMessage(ref message);DispatchMessageW(ref message);}
        }catch(Exception error){failure=error;ready.Set();}});containerThread.IsBackground=true;containerThread.SetApartmentState(ApartmentState.STA);containerThread.Start();
        if(!ready.WaitOne(5000))throw new InvalidOperationException("The native application stage did not start.");ready.Dispose();if(failure!=null)throw failure;
    }
    private static void Reparent(IntPtr hwnd,IntPtr parent,int style) {
        int original=GetWindowLongW(hwnd,-16);IntPtr owner=GetWindow(hwnd,4),originalParent=(original&WS_CHILD)!=0?GetParent(hwnd):IntPtr.Zero;
        // A top-level owned popup must release its owner before becoming a
        // child. Otherwise changing WS_CHILD can reinterpret that modal owner
        // as a parent during the transition. Its original owner is retained in
        // HostedWindow for release; the application's modal loop is untouched.
        try {
            if((original&WS_CHILD)==0&&owner!=IntPtr.Zero)SetOwner(hwnd,IntPtr.Zero);
            SetStyle(hwnd,style);SetLastError(0);IntPtr prior=SetParent(hwnd,parent);int error=Marshal.GetLastWin32Error();
            if((prior==IntPtr.Zero&&error!=0)||GetParent(hwnd)!=parent)throw WindowError("set_parent:"+parent.ToInt64(),hwnd,error);
        }catch{
            if(IsWindow(hwnd)){try{SetParent(hwnd,originalParent);SetStyle(hwnd,original);if((original&WS_CHILD)==0)SetOwner(hwnd,owner);}catch(Win32Exception){}}
            throw;
        }
        SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0004|0x0010|0x0020);
    }
    public static HostInfo Attach(string application,string host,int x,int y,int width,int height) {return Attach(application,host,x,y,width,height,null);}
    public static HostInfo Attach(string application,string host,int x,int y,int width,int height,string[] existingWindowIds) {lock(gate){
        IntPtr target=Parse(application),parent=Parse(host);if(target==appWindow&&parent==blackiceWindow)return Position(x,y,width,height);
        uint pid,hostPid;GetWindowThreadProcessId(target,out pid);GetWindowThreadProcessId(parent,out hostPid);
        if(pid==0||pid==hostPid||pid==Process.GetCurrentProcess().Id)throw new ArgumentException("Cannot embed the BLACKICE window into itself.");
        ValidateBounds(parent,x,y,width,height);
        if(SessionAlive()){
            // One helper retains one exact application process. Another app
            // uses another retained workspace host; never expose the old app
            // by automatically detaching it while switching selections.
            if(parent!=blackiceWindow||pid!=sessionPid)throw new InvalidOperationException("The existing native application session must remain owned by its retained workspace host.");
            HostedWindow tracked;
            if(documents.TryGetValue(target.ToInt64(),out tracked)&&SameWindow(tracked)){appWindow=target;RaiseChild(target,containerWindow);return Position(x,y,width,height);}
            if(target==parent||(GetWindowLongW(target,-16)&WS_CHILD)!=0||OwnedDialog(target))throw new ArgumentException("Choose an application document window, not a dialog or another native child.");
            var additional=RememberWindow(target);if(additional.started!=sessionStarted)throw new InvalidOperationException("The application process lifetime changed before document selection.");
            Reparent(target,containerWindow,(additional.style|WS_CHILD)&~WS_POPUP);documents[target.ToInt64()]=additional;preexistingWindows.Remove(target.ToInt64());appWindow=target;Transition("document_selected");RaiseChild(target,containerWindow);return Position(x,y,width,height);
        }
        if(target==parent||(GetWindowLongW(target,-16)&WS_CHILD)!=0)throw new ArgumentException("Choose an ordinary top-level application window, not an existing child.");
        Detach();
        var initial=RememberWindow(target);
        // Exclude actual existing user windows in this process. Subsequent SDI
        // documents are session members; an already-open unrelated workbook is not.
        if(existingWindowIds==null)EnumWindows(delegate(IntPtr hwnd,IntPtr unused){uint existingPid;GetWindowThreadProcessId(hwnd,out existingPid);if(hwnd!=target&&existingPid==pid&&IsWindowVisible(hwnd))preexistingWindows.Add(hwnd.ToInt64());return true;},IntPtr.Zero);
        else foreach(string value in existingWindowIds){long id;if(!long.TryParse(value,out id)||id<=0||id==target.ToInt64())continue;IntPtr hwnd=new IntPtr(id);uint existingPid;GetWindowThreadProcessId(hwnd,out existingPid);if(IsWindow(hwnd)&&existingPid==pid)preexistingWindows.Add(id);}
        CreateContainer(parent,x,y,width,height);blackiceWindow=parent;stage=new Rect {Left=x,Top=y,Right=x+width,Bottom=y+height};
        sessionPid=pid;sessionStarted=initial.started;sessionLifetime=initial.lifetime;sessionId=Guid.NewGuid().ToString("N");
        try{ProtectHostPainting();Reparent(target,containerWindow,(initial.style|WS_CHILD)&~WS_POPUP);}
        catch{RestoreHostPainting();PostMessageW(containerWindow,0x0010,UIntPtr.Zero,IntPtr.Zero);containerWindow=IntPtr.Zero;blackiceWindow=IntPtr.Zero;sessionId=null;sessionPid=0;sessionStarted=0;preexistingWindows.Clear();throw;}
        documents[target.ToInt64()]=initial;appWindow=target;visible=true;scrollX=scrollY=0;scrollWindow=target;modeReason=null;Transition("attached");
        try{if(IsIconic(target))ShowWindow(target,4);RefreshSession();LayoutWindows();ShowWindow(containerWindow,8);RaiseChildStage();return Status();}catch{modeReason="Application remains embedded after a layout error.";throw;}
    }}
    private static bool OwnedDialog(IntPtr hwnd) {
        uint candidatePid;GetWindowThreadProcessId(hwnd,out candidatePid);
        IntPtr next=hwnd;for(int index=0;index<20;index++){next=GetWindow(next,4);if(next==IntPtr.Zero)break;if(documents.ContainsKey(next.ToInt64())||dialogs.ContainsKey(next.ToInt64()))return true;if((next==blackiceWindow||next==containerWindow)&&candidatePid==sessionPid)return true;}
        // Standard modal dialogs can be owned by a hidden toolkit helper. A
        // disabled managed document plus the OS dialog class/style is evidence
        // of modality; hidden helper windows themselves never become documents.
        if(candidatePid==sessionPid&&!preexistingWindows.Contains(hwnd.ToInt64())){bool disabled=false;foreach(var root in documents.Values)if(SameWindow(root)&&!IsWindowEnabled(root.handle)){disabled=true;break;}if(disabled){var name=new StringBuilder(128);GetClassNameW(hwnd,name,name.Capacity);if(name.ToString()=="#32770"||(GetWindowLongW(hwnd,-20)&1)!=0)return true;}}
        return false;
    }
    private static bool ModalDialog(IntPtr hwnd) {
        IntPtr next=hwnd;for(int index=0;index<20;index++){next=GetWindow(next,4);if(next==IntPtr.Zero)break;if((documents.ContainsKey(next.ToInt64())||dialogs.ContainsKey(next.ToInt64()))&&!IsWindowEnabled(next))return true;}
        var name=new StringBuilder(128);GetClassNameW(hwnd,name,name.Capacity);if(name.ToString()!="#32770"&&(GetWindowLongW(hwnd,-20)&1)==0)return false;
        foreach(var root in documents.Values)if(SameWindow(root)&&!IsWindowEnabled(root.handle))return true;return false;
    }
    private static void RememberRegion(HostedWindow window) {IntPtr region=CreateRectRgn(0,0,0,0);if(region==IntPtr.Zero)throw WindowError("create_original_region",window.handle,Marshal.GetLastWin32Error());if(GetWindowRgn(window.handle,region)!=0)window.originalRegion=region;else DeleteObject(region);}
    private static void ReleaseRegion(HostedWindow window) {if(window.originalRegion!=IntPtr.Zero){DeleteObject(window.originalRegion);window.originalRegion=IntPtr.Zero;}if(window.releaseRegion!=IntPtr.Zero){DeleteObject(window.releaseRegion);window.releaseRegion=IntPtr.Zero;}window.releasePrepared=false;}
    private static void ClipModal(HostedWindow window) {
        Rect area=WindowBounds(window.handle),clip=Intersection(area,StageClientBounds());
        if(!visible||!IsWindowVisible(containerWindow))clip=new Rect {Left=area.Left,Top=area.Top,Right=area.Left,Bottom=area.Top};
        var local=new Rect {Left=clip.Left-area.Left,Top=clip.Top-area.Top,Right=clip.Right-area.Left,Bottom=clip.Bottom-area.Top};
        IntPtr region=CreateRectRgn(local.Left,local.Top,local.Right,local.Bottom);if(region==IntPtr.Zero)throw WindowError("create_modal_clip",window.handle,Marshal.GetLastWin32Error());
        if(window.originalRegion!=IntPtr.Zero&&CombineRgn(region,region,window.originalRegion,1)==0){DeleteObject(region);throw WindowError("intersect_modal_clip",window.handle,Marshal.GetLastWin32Error());}
        if(window.regionApplied&&SameRect(window.appliedRegion,local)){IntPtr actual=CreateRectRgn(0,0,0,0);if(actual!=IntPtr.Zero){bool same=GetWindowRgn(window.handle,actual)!=0&&EqualRgn(actual,region);DeleteObject(actual);if(same){DeleteObject(region);return;}}}
        if(SetWindowRgn(window.handle,region,true)==0){int error=Marshal.GetLastWin32Error();DeleteObject(region);throw WindowError("set_modal_clip",window.handle,error);}
        // SetWindowRgn transfers ownership to Windows. Do not free this region.
        window.appliedRegion=local;window.regionApplied=true;
    }
    private static Rect ActualRegion(HostedWindow window,out bool clipped) {IntPtr region=CreateRectRgn(0,0,0,0);Rect local=new Rect();clipped=false;if(region==IntPtr.Zero)return local;try{int kind=GetWindowRgn(window.handle,region);if(kind==0)return local;clipped=true;GetRgnBox(region,out local);if(kind==1)return new Rect();Rect area=WindowBounds(window.handle);return new Rect {Left=area.Left+local.Left,Top=area.Top+local.Top,Right=area.Left+local.Right,Bottom=area.Top+local.Bottom};}finally{DeleteObject(region);}}
    private static void CaptureDialogs() {
        var found=new List<IntPtr>();EnumWindows(delegate(IntPtr hwnd,IntPtr unused){if(!documents.ContainsKey(hwnd.ToInt64())&&IsWindowVisible(hwnd)&&OwnedDialog(hwnd))found.Add(hwnd);return found.Count<64;},IntPtr.Zero);
        foreach(IntPtr hwnd in found){if(dialogs.ContainsKey(hwnd.ToInt64())||!IsWindow(hwnd)||!IsWindowVisible(hwnd)||!OwnedDialog(hwnd))continue;var record=RememberWindow(hwnd);
            if(ModalDialog(hwnd)){
                // A running native modal loop can end when reparenting changes
                // its top-level visibility semantics. Keep its HWND/style/owner
                // intact; manage actual drawing/input with a bounded region.
                record.managedModal=true;RememberRegion(record);dialogs[hwnd.ToInt64()]=record;Transition("modal_added");ClipModal(record);continue;
            }
            try{Reparent(hwnd,containerWindow,(record.style|WS_CHILD)&~WS_POPUP);}catch(Win32Exception){if(!SameWindow(record))continue;throw;}
            if(!SameWindow(record))continue;dialogs[hwnd.ToInt64()]=record;Transition("dialog_added");SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0004|0x0010);
        }
    }
    private static void RepairWindow(HostedWindow window,bool document) {
        int style=GetWindowLongW(window.handle,-16);
        if(GetParent(window.handle)!=containerWindow||(style&WS_CHILD)==0){if((style&WS_CHILD)==0){window.style=style;IntPtr owner=GetWindow(window.handle,4);if(owner!=containerWindow&&owner!=blackiceWindow)window.owner=owner;}if((style&0x10000000)!=0)window.wasVisible=true;
            Reparent(window.handle,containerWindow,document?(window.style|WS_CHILD)&~WS_POPUP:(window.style|WS_CHILD)&~WS_POPUP);requestedLayouts.Remove(window.handle.ToInt64());Transition("root_repaired");
        }else window.wasVisible=(GetWindowLongW(window.handle,-16)&0x10000000)!=0;
    }
    private static void RefreshSession() {
        if(refreshingSession||sessionId==null)return;refreshingSession=true;
        try {
            if(!SessionAlive()){Detach();return;}
            // An unavailable host is not permission to release a living app to the desktop.
            if(blackiceWindow==IntPtr.Zero||!IsWindow(blackiceWindow)||containerWindow==IntPtr.Zero||!IsWindow(containerWindow)){
                modeReason="BLACKICE parent unavailable; application has not been deliberately released.";visible=false;return;
            }
            var expired=new List<long>();foreach(var item in documents)if(!SameWindow(item.Value))expired.Add(item.Key);foreach(long key in expired){documents.Remove(key);requestedLayouts.Remove(key);Transition("document_closed");}
            expired.Clear();foreach(var item in dialogs)if(!SameWindow(item.Value))expired.Add(item.Key);foreach(long key in expired){ReleaseRegion(dialogs[key]);dialogs.Remove(key);requestedLayouts.Remove(key);Transition("dialog_closed");}
            foreach(var root in documents.Values)RepairWindow(root,true);foreach(var popup in dialogs.Values)if(popup.managedModal)ClipModal(popup);else RepairWindow(popup,false);
            bool scan=DateTime.UtcNow.Ticks-lastSessionScan>=TimeSpan.TicksPerMillisecond*200;
            if(scan){lastSessionScan=DateTime.UtcNow.Ticks;CaptureDialogs();
            var found=new List<IntPtr>();EnumWindows(delegate(IntPtr hwnd,IntPtr unused){uint pid;GetWindowThreadProcessId(hwnd,out pid);long key=hwnd.ToInt64();if(pid!=sessionPid||documents.ContainsKey(key)||dialogs.ContainsKey(key)||preexistingWindows.Contains(key)||!IsWindowVisible(hwnd)||OwnedDialog(hwnd))return true;
                int extended=GetWindowLongW(hwnd,-20);if((extended&0x80)!=0&&(extended&0x40000)==0)return true;IntPtr owner=GetWindow(hwnd,4);if(owner!=IntPtr.Zero&&IsWindowVisible(owner)&&!documents.ContainsKey(owner.ToInt64()))return true;Rect bounds=WindowBounds(hwnd);if(bounds.Width<64||bounds.Height<40||String.IsNullOrWhiteSpace(Title(hwnd)))return true;found.Add(hwnd);return found.Count<64;},IntPtr.Zero);
            foreach(IntPtr hwnd in found){var root=RememberWindow(hwnd);if(root.pid!=sessionPid||root.started!=sessionStarted)continue;Reparent(hwnd,containerWindow,(root.style|WS_CHILD)&~WS_POPUP);documents[hwnd.ToInt64()]=root;appWindow=hwnd;Transition("document_added");if(visible)RaiseChild(hwnd,containerWindow);}
            CaptureDialogs();}
            if(visible)for(IntPtr next=GetWindow(containerWindow,5);next!=IntPtr.Zero;next=GetWindow(next,2))if(documents.ContainsKey(next.ToInt64())&&IsWindowVisible(next)){appWindow=next;break;}
            if(!documents.ContainsKey(appWindow.ToInt64())){appWindow=IntPtr.Zero;HostedWindow newest=null;foreach(var root in documents.Values)if(newest==null||root.sequence>newest.sequence)newest=root;if(newest!=null)appWindow=newest.handle;}
            bool display=false;if(visible){foreach(var root in documents.Values)if(root.wasVisible){display=true;break;}if(!display)foreach(var popup in dialogs.Values)if(popup.wasVisible){display=true;break;}}
            if(IsWindowVisible(containerWindow)!=display)ShowWindow(containerWindow,display?8:0);
        }finally{refreshingSession=false;}
    }
    private static void PositionChild(IntPtr hwnd,int x,int y,int width,int height) {
        var desired=new Rect {Left=x,Top=y,Right=x+width,Bottom=y+height};Rect previous;
        if(requestedLayouts.TryGetValue(hwnd.ToInt64(),out previous)&&previous.Left==desired.Left&&previous.Top==desired.Top&&previous.Right==desired.Right&&previous.Bottom==desired.Bottom)return;
        if(SetWindowPos(hwnd,IntPtr.Zero,x,y,width,height,0x0004|0x0010|0x4000))requestedLayouts[hwnd.ToInt64()]=desired;
    }
    private static void LayoutWindows() {
        if(!IsEmbedded())return;Rect client;if(!GetClientRect(containerWindow,out client))return;
        foreach(var root in documents.Values)PositionChild(root.handle,0,0,Math.Max(1,client.Width),Math.Max(1,client.Height));
        IntPtr overflow=appWindow;Rect overflowBounds=WindowBounds(appWindow);
        foreach(var item in dialogs){var popup=item.Value;if(!IsWindow(popup.handle))continue;
            int width=Math.Min(Math.Max(80,popup.bounds.Width),Math.Max(80,client.Width)),height=Math.Min(Math.Max(60,popup.bounds.Height),Math.Max(60,client.Height));
            Rect screen=StageClientBounds();
            PositionChild(popup.handle,(popup.managedModal?screen.Left:0)+Math.Max(0,(client.Width-width)/2),(popup.managedModal?screen.Top:0)+Math.Max(0,(client.Height-height)/2),width,height);
            Rect actual=WindowBounds(popup.handle);if(IsWindowVisible(popup.handle)){overflow=popup.handle;overflowBounds=actual;}
        }
        if(scrollWindow!=overflow){scrollWindow=overflow;scrollX=scrollY=0;}
        bool horizontal=overflowBounds.Width>client.Width+1,vertical=overflowBounds.Height>client.Height+1;
        ShowScrollBar(containerWindow,0,horizontal);ShowScrollBar(containerWindow,1,vertical);GetClientRect(containerWindow,out client);
        var h=new ScrollInfo {size=(uint)Marshal.SizeOf(typeof(ScrollInfo)),mask=7,min=0,max=Math.Max(0,overflowBounds.Width-1),page=(uint)Math.Max(1,client.Width),position=scrollX};
        var v=new ScrollInfo {size=(uint)Marshal.SizeOf(typeof(ScrollInfo)),mask=7,min=0,max=Math.Max(0,overflowBounds.Height-1),page=(uint)Math.Max(1,client.Height),position=scrollY};
        scrollX=Math.Max(0,Math.Min(scrollX,Math.Max(0,h.max-(int)h.page+1)));scrollY=Math.Max(0,Math.Min(scrollY,Math.Max(0,v.max-(int)v.page+1)));h.position=scrollX;v.position=scrollY;SetScrollInfo(containerWindow,0,ref h,true);SetScrollInfo(containerWindow,1,ref v,true);
        HostedWindow scrolling;bool modal=dialogs.TryGetValue(overflow.ToInt64(),out scrolling)&&scrolling.managedModal;
        if(overflow!=IntPtr.Zero&&(horizontal||vertical)){Rect origin=StageClientBounds();SetWindowPos(overflow,IntPtr.Zero,(modal?origin.Left:0)-scrollX,(modal?origin.Top:0)-scrollY,0,0,0x0001|0x0004|0x0010);}
        foreach(var popup in dialogs.Values)if(popup.managedModal&&SameWindow(popup))ClipModal(popup);
        RaiseDialogs();
    }
    public static WindowInfo[] Dialogs() {lock(gate){var result=new List<WindowInfo>();RefreshSession();if(!IsEmbedded())return result.ToArray();LayoutWindows();Rect clip=WindowBounds(containerWindow);
        foreach(var item in dialogs){var popup=item.Value;var hwnd=popup.handle;uint pid;GetWindowThreadProcessId(hwnd,out pid);Rect bounds=WindowBounds(hwnd),region=new Rect();bool clipped=false,contained=GetParent(hwnd)==containerWindow;if(popup.managedModal){region=ActualRegion(popup,out clipped);Rect allowed=StageClientBounds();contained=clipped&&(region.Width==0||region.Height==0||(region.Left>=allowed.Left&&region.Top>=allowed.Top&&region.Right<=allowed.Right&&region.Bottom<=allowed.Bottom));}result.Add(new WindowInfo {id=hwnd.ToInt64().ToString(),title=Title(hwnd),process="Dialog",pid=(int)pid,parentWindowId=GetParent(hwnd).ToInt64().ToString(),ownerWindowId=GetWindow(hwnd,4).ToInt64().ToString(),containerWindowId=containerWindow.ToInt64().ToString(),hostWindowId=blackiceWindow.ToInt64().ToString(),presentation=popup.managedModal?"managed_modal":"embedded_child",ownershipVerified=OwnedDialog(hwnd),clipped=clipped,contained=contained,presented=visible&&IsWindowVisible(containerWindow)&&IsWindowVisible(hwnd)&&(!popup.managedModal||region.Width>0&&region.Height>0),bounds=bounds,regionBounds=region,visibleBounds=popup.managedModal?region:Intersection(bounds,clip)});}return result.ToArray();}}
    public static HostInfo Position(int x,int y,int width,int height) {lock(gate){RefreshSession();if(sessionId==null)throw new InvalidOperationException("The embedded application is no longer available.");ValidateBounds(blackiceWindow,x,y,width,height);stage=new Rect {Left=x,Top=y,Right=x+width,Bottom=y+height};
        if(!SetWindowPos(containerWindow,IntPtr.Zero,x,y,width,height,0x0004|0x0010))throw new Win32Exception(Marshal.GetLastWin32Error());LayoutWindows();RaiseChildStage();return Status();}}
    public static HostInfo SetVisible(bool show) {lock(gate){RefreshSession();if(sessionId==null)return Status();visible=show;
        // Hide the native ancestor, not application HWNDs. A modal loop can
        // interpret hiding its window or owner as cancellation. Modal popups
        // keep their visible style and receive an empty drawing/input region.
        if(!show){foreach(var popup in dialogs.Values)if(popup.managedModal&&SameWindow(popup))ClipModal(popup);ShowWindow(containerWindow,0);}else{RefreshSession();LayoutWindows();RaiseChildStage();}return Status();}}
    // Request ordinary application shutdown without moving its window outside BLACKICE.
    // WM_CLOSE lets the application present its own save/discard/cancel dialog.
    public static HostInfo RequestClose() {lock(gate){
        RefreshSession();
        if(sessionId==null||!SessionAlive())return Status();
        int requested=0;
        foreach(var root in new List<HostedWindow>(documents.Values)){
            if(!SameWindow(root)||GetParent(root.handle)!=containerWindow)continue;
            if(!PostMessageW(root.handle,0x0010,UIntPtr.Zero,IntPtr.Zero))throw WindowError("request_close",root.handle,Marshal.GetLastWin32Error());
            requested++;
        }
        if(requested==0)throw new InvalidOperationException("No embedded application window is available to close.");
        Transition("close_requested");
        return Status();
    }}
    public static HostInfo Focus() {lock(gate){if(!IsEmbedded())throw new InvalidOperationException("Load an application window first.");SetVisible(true);IntPtr target=appWindow;foreach(var popup in dialogs.Values)if(IsWindowVisible(popup.handle))target=popup.handle;
        uint pid,targetThread=GetWindowThreadProcessId(target,out pid),currentThread=GetCurrentThreadId();bool joined=targetThread!=currentThread&&AttachThreadInput(currentThread,targetThread,true);try{SetFocus(target);}finally{if(joined)AttachThreadInput(currentThread,targetThread,false);}return Status();}}
    public interface IReleaseTransaction : IDisposable {void Mask();void RestorePlacement();bool ConfirmReleased();void RevealReleased();void Commit();bool RollbackBounded();void KeepMasked();}
    // The native boundary is injectable to exercise failures and intermediate
    // drawing states without creating a window or moving desktop focus.
    public static void ReleaseSafely(IReleaseTransaction operation) {
        ReleaseAllSafely(new IReleaseTransaction[] {operation});
    }
    public static void ReleaseAllSafely(IReleaseTransaction[] operations) {
        var masked=new List<IReleaseTransaction>();
        try{foreach(var operation in operations){operation.Mask();masked.Add(operation);}foreach(var operation in operations)operation.RestorePlacement();foreach(var operation in operations)if(!operation.ConfirmReleased())throw new InvalidOperationException("Windows did not confirm the released application's final placement.");foreach(var operation in operations)operation.RevealReleased();foreach(var operation in operations)operation.Commit();}
        catch{foreach(var operation in masked)try{operation.Mask();}catch{}for(int index=masked.Count-1;index>=0;index--){bool bounded=false;try{bounded=masked[index].RollbackBounded();}catch{}if(!bounded)masked[index].KeepMasked();}throw;}
        finally{foreach(var operation in operations)operation.Dispose();}
    }
    private static IntPtr CopyWindowRegion(IntPtr hwnd) {IntPtr region=CreateRectRgn(0,0,0,0);if(region==IntPtr.Zero)throw WindowError("copy_region",hwnd,Marshal.GetLastWin32Error());if(GetWindowRgn(hwnd,region)!=0)return region;DeleteObject(region);return IntPtr.Zero;}
    private static IntPtr CopyRegion(IntPtr original,IntPtr hwnd) {if(original==IntPtr.Zero)return IntPtr.Zero;IntPtr region=CreateRectRgn(0,0,0,0);if(region==IntPtr.Zero)throw WindowError("clone_region",hwnd,Marshal.GetLastWin32Error());if(CombineRgn(region,original,IntPtr.Zero,5)==0){DeleteObject(region);throw WindowError("clone_region",hwnd,Marshal.GetLastWin32Error());}return region;}
    private sealed class WindowsReleaseTransaction : IReleaseTransaction {
        readonly HostedWindow window;readonly IntPtr boundedParent,boundedOwner;readonly int boundedStyle;readonly Rect boundedBounds;
        IntPtr boundedRegion,targetRegion;bool masked;
        public WindowsReleaseTransaction(HostedWindow value) {window=value;boundedStyle=GetWindowLongW(window.handle,-16);boundedParent=(boundedStyle&WS_CHILD)!=0?GetParent(window.handle):IntPtr.Zero;boundedOwner=GetWindow(window.handle,4);boundedBounds=WindowBounds(window.handle);boundedRegion=CopyWindowRegion(window.handle);try{if(!window.managedModal&&!window.releasePrepared){window.releaseRegion=CopyWindowRegion(window.handle);window.releasePrepared=true;}targetRegion=CopyRegion(window.managedModal?window.originalRegion:window.releaseRegion,window.handle);}catch{if(boundedRegion!=IntPtr.Zero)DeleteObject(boundedRegion);throw;}}
        void RequireSame(){if(!SameWindow(window))throw new InvalidOperationException("The application window/process lifetime changed during release.");}
        void Place(Rect bounds,uint flags){RequireSame();if(!SetWindowPos(window.handle,IntPtr.Zero,bounds.Left,bounds.Top,Math.Max(1,bounds.Width),Math.Max(1,bounds.Height),flags|0x0004|0x0010))throw WindowError("release_position",window.handle,Marshal.GetLastWin32Error());}
        void ApplyRegion(ref IntPtr region,string operation){RequireSame();if(SetWindowRgn(window.handle,region,true)==0)throw WindowError(operation,window.handle,Marshal.GetLastWin32Error());region=IntPtr.Zero;}
        public void Mask(){RequireSame();IntPtr empty=CreateRectRgn(0,0,0,0);if(empty==IntPtr.Zero)throw WindowError("release_mask",window.handle,Marshal.GetLastWin32Error());try{ApplyRegion(ref empty,"release_mask");masked=true;}finally{if(empty!=IntPtr.Zero)DeleteObject(empty);}}
        public void RestorePlacement(){RequireSame();if(!window.managedModal){SetLastError(0);IntPtr prior=SetParent(window.handle,window.parent);int error=Marshal.GetLastWin32Error();if(prior==IntPtr.Zero&&error!=0)throw WindowError("release_parent",window.handle,error);SetStyle(window.handle,(window.style&~0x10000000)|(window.wasVisible?0x10000000:0));}
            // Apply the restored top-level frame/position before restoring a
            // real owner. All these transitions remain masked and inactive.
            Place(window.bounds,window.managedModal?0u:0x0020u);if(!window.managedModal){RequireSame();SetOwner(window.handle,window.owner!=IntPtr.Zero&&IsWindow(window.owner)?window.owner:IntPtr.Zero);}}
        public bool ConfirmReleased(){if(!SameWindow(window))return false;Rect actual=WindowBounds(window.handle);if(Math.Abs(actual.Left-window.bounds.Left)>2||Math.Abs(actual.Top-window.bounds.Top)>2)return false;if(window.managedModal)return GetWindow(window.handle,4)==boundedOwner&&(GetWindowLongW(window.handle,-16)&WS_CHILD)==0;return (GetWindowLongW(window.handle,-16)&WS_CHILD)==0&&GetAncestor(window.handle,2)==window.handle;}
        public void RevealReleased(){ApplyRegion(ref targetRegion,"release_original_region");masked=false;}
        public void Commit(){ReleaseRegion(window);}
        public bool RollbackBounded(){RequireSame();if(!window.managedModal){if(boundedParent==IntPtr.Zero||!IsWindow(boundedParent))return false;Reparent(window.handle,boundedParent,boundedStyle);}else if(GetWindow(window.handle,4)!=boundedOwner)return false;
            Rect desired=boundedBounds;if(boundedParent!=IntPtr.Zero){var origin=new Point();if(!ClientToScreen(boundedParent,ref origin))return false;desired.Left-=origin.X;desired.Right-=origin.X;desired.Top-=origin.Y;desired.Bottom-=origin.Y;}Place(desired,0x0004|0x0010|0x0020);
            Rect actual=WindowBounds(window.handle);bool geometry=Math.Abs(actual.Left-boundedBounds.Left)<=2&&Math.Abs(actual.Top-boundedBounds.Top)<=2;if(!geometry||!window.managedModal&&GetParent(window.handle)!=boundedParent)return false;ApplyRegion(ref boundedRegion,"rollback_bounded_region");masked=false;window.regionApplied=false;if(!window.managedModal){if(window.releaseRegion!=IntPtr.Zero)DeleteObject(window.releaseRegion);window.releaseRegion=IntPtr.Zero;window.releasePrepared=false;}return true;}
        public void KeepMasked(){if(!masked||!SameWindow(window))return;IntPtr empty=CreateRectRgn(0,0,0,0);if(empty==IntPtr.Zero)return;try{ApplyRegion(ref empty,"keep_failed_release_masked");}finally{if(empty!=IntPtr.Zero)DeleteObject(empty);}}
        public void Dispose(){if(boundedRegion!=IntPtr.Zero)DeleteObject(boundedRegion);if(targetRegion!=IntPtr.Zero)DeleteObject(targetRegion);}
    }
    private static void Restore(HostedWindow window) {if(!SameWindow(window)){ReleaseRegion(window);return;}ReleaseSafely(new WindowsReleaseTransaction(window));}
    public static HostInfo Detach() {lock(gate){
        var ordered=new List<HostedWindow>(dialogs.Values);ordered.Reverse();var roots=new List<HostedWindow>(documents.Values);roots.Reverse();ordered.AddRange(roots);var releases=new List<IReleaseTransaction>();
        try{foreach(var window in ordered){if(SameWindow(window))releases.Add(new WindowsReleaseTransaction(window));else ReleaseRegion(window);}}catch{foreach(var release in releases)release.Dispose();throw;}
        ReleaseAllSafely(releases.ToArray());dialogs.Clear();documents.Clear();
        RestoreHostPainting();IntPtr container=containerWindow;appWindow=IntPtr.Zero;blackiceWindow=IntPtr.Zero;containerWindow=IntPtr.Zero;visible=true;modeReason=null;scrollX=scrollY=0;scrollWindow=IntPtr.Zero;dialogSequence=0;sessionId=null;sessionPid=0;sessionStarted=0;sessionLifetime=null;preexistingWindows.Clear();requestedLayouts.Clear();lastTransition=null;transitionCount=0;lastSessionScan=0;
        foreach(var lifetime in processLifetimes.Values)if(lifetime.handle!=IntPtr.Zero){CloseHandle(lifetime.handle);lifetime.handle=IntPtr.Zero;}processLifetimes.Clear();
        if(container!=IntPtr.Zero&&IsWindow(container))PostMessageW(container,0x0010,UIntPtr.Zero,IntPtr.Zero);return Status();
    }}
}
