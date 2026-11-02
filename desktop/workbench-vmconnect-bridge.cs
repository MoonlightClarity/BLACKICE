// BLACKICE Workbench: embed Microsoft's VMConnect window in the Electron HWND.
// No guest image capture, VM disk mutation, host keyboard injection or shell
// elevated operation. Native process is launched hidden before parenting.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BlackiceVMConnectDock {
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left,Top,Right,Bottom; public int Width {get{return Right-Left;}} public int Height {get{return Bottom-Top;}} }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate bool EnumProc(IntPtr hwnd,IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback,IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr context);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr hwnd,int index);
    [DllImport("user32.dll",SetLastError=true)] private static extern int SetWindowLongW(IntPtr hwnd,int index,int value);
    [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetParent(IntPtr hwnd,IntPtr parent);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int w,int h,uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] private static extern bool EnableWindow(IntPtr hwnd,bool enabled);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd,out Rect region);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd,out Rect region);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd,StringBuilder value,int count);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd,StringBuilder value,int count);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool PostMessageW(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);

    private const int WS_CHILD=0x40000000;
    private const int GWL_EXSTYLE=-20, WS_EX_NOACTIVATE=0x08000000;
    private const uint SWP_NOMOVE=0x0002, SWP_NOSIZE=0x0001, SWP_HIDEWINDOW=0x0080;
    private const int WS_POPUP=unchecked((int)0x80000000);
    private const int WS_CAPTION=0x00c00000,WS_THICKFRAME=0x00040000,WS_SYSMENU=0x00080000;
    private const int WS_MINIMIZEBOX=0x00020000,WS_MAXIMIZEBOX=0x00010000;
    private const uint SWP_NOACTIVATE=0x0010,SWP_NOZORDER=0x0004,SWP_FRAMECHANGED=0x0020,SWP_SHOWWINDOW=0x0040,SWP_NOSENDCHANGING=0x0400;
    private static Process vmProcess;
    private static IntPtr guestWindow=IntPtr.Zero,parentWindow=IntPtr.Zero,oldForeground=IntPtr.Zero;
    private static string vmName;
    private static bool shown=false,inputEnabled=false;
    private static bool foregroundUnaffected=true;
    private static int lastX,lastY,lastWidth,lastHeight;
    private static readonly object gate=new object();

    public static object Status(){
        lock(gate){
            bool attached=guestWindow!=IntPtr.Zero&&IsWindow(guestWindow)&&parentWindow!=IntPtr.Zero&&GetParent(guestWindow)==parentWindow;
            bool running=false;
            try{running=vmProcess!=null&&!vmProcess.HasExited;}catch{}
            return new {
                connected=attached,processRunning=running,shown=shown&&attached,
                userInput=inputEnabled,vm=vmName,
                childHwnd=attached?guestWindow.ToInt64().ToString():null,
                parentHwnd=attached?parentWindow.ToInt64().ToString():null,
                pid=running?vmProcess.Id:0,x=lastX,y=lastY,width=lastWidth,height=lastHeight,
                hostForegroundUnaffected=foregroundUnaffected
            };
        }
    }
    private static string WindowText(IntPtr hwnd){
        var s=new StringBuilder(256);GetWindowTextW(hwnd,s,s.Capacity);return s.ToString();
    }
    private static bool IsErrorDialog(IntPtr window){
        bool error=false;
        EnumProc scan=delegate(IntPtr child,IntPtr ignored){
            string text=WindowText(child);
            if(text.IndexOf("An error occurred",StringComparison.OrdinalIgnoreCase)>=0||
               text.IndexOf("do not have the required permission",StringComparison.OrdinalIgnoreCase)>=0)
                error=true;
            return true;
        };
        EnumChildWindows(window,scan,IntPtr.Zero);
        return error;
    }
    // A VMConnect GUI can be created by an elevated helper while BLACKICE
    // remains unelevated. Keep all provisional VMConnect top-level windows
    // hidden and non-activating before selecting the actual guest console.
    private static bool SameForeground(IntPtr before){
        return before==IntPtr.Zero||GetForegroundWindow()==before;
    }
    private static void KeepBackground(IntPtr hwnd){
        int style=GetWindowLongW(hwnd,GWL_EXSTYLE);
        if((style&WS_EX_NOACTIVATE)==0)
            SetWindowLongW(hwnd,GWL_EXSTYLE,style|WS_EX_NOACTIVATE);
        SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,
            SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_HIDEWINDOW|SWP_NOSENDCHANGING);
    }
    private static IntPtr FindConnectWindow(int pid,string name){
        IntPtr best=IntPtr.Zero;
        int bestScore=int.MinValue;
        EnumWindows(delegate(IntPtr hwnd,IntPtr _){
            uint found;GetWindowThreadProcessId(hwnd,out found);
            if(found!=(uint)pid||GetParent(hwnd)!=IntPtr.Zero)return true;
            KeepBackground(hwnd);
            var text=WindowText(hwnd);
            var cls=new StringBuilder(128);GetClassNameW(hwnd,cls,cls.Capacity);
            Rect rect;GetWindowRect(hwnd,out rect);
            // A generic "Virtual Machine Connection" #32770 dialog can be
            // an AUTHORIZATION ERROR, not the actual console. Never embed it.
            // The connected VM's top-level window must identify the target VM.
            int score=(text.IndexOf(name,StringComparison.OrdinalIgnoreCase)>=0?500:-1000)+
                (text.IndexOf("Virtual Machine Connection",StringComparison.OrdinalIgnoreCase)>=0?400:0)+
                (rect.Width>=300&&rect.Height>=200?100:0)+
                (IsWindowVisible(hwnd)?50:0);
            if(score>bestScore){bestScore=score;best=hwnd;}
            return true;
        },IntPtr.Zero);
        return bestScore>=100?best:IntPtr.Zero;
    }
    private static IntPtr ParseHandle(string value){
        long number;
        if(!long.TryParse(value,out number)||number<=0)throw new ArgumentException("Invalid BLACKICE native window handle.");
        var handle=new IntPtr(number);
        if(!IsWindow(handle))throw new ArgumentException("BLACKICE window is no longer available.");
        return handle;
    }
    private static void Bounds(IntPtr parent,int x,int y,int w,int h){
        if(w<100||h<90||w>16384||h>16384||x<0||y<0)throw new ArgumentException("Invalid VM viewport bounds.");
        Rect rect;
        if(!GetClientRect(parent,out rect))throw new Win32Exception(Marshal.GetLastWin32Error());
        if(x>=rect.Width||y>=rect.Height)throw new ArgumentException("VM viewport must be inside BLACKICE.");
    }
    public static object Attach(string parent,string name,string vmId,int x,int y,int width,int height){
        lock(gate){
            var host=ParseHandle(parent);
            Bounds(host,x,y,width,height);
            if(guestWindow!=IntPtr.Zero&&IsWindow(guestWindow)&&GetParent(guestWindow)==host)
                return Position(x,y,width,height);
            if(vmProcess!=null&&!vmProcess.HasExited)
                throw new InvalidOperationException("An earlier VMConnect process must be inspected; it is not safe to launch another.");
            if(String.IsNullOrWhiteSpace(name)||name.Length>90||name.IndexOf('"')>=0)
                throw new ArgumentException("Invalid VM name.");
            Guid resolved; if(!Guid.TryParse(vmId,out resolved)||resolved==Guid.Empty)
                throw new ArgumentException("Windows did not resolve a Hyper-V VM GUID.");
            string executable=System.IO.Path.Combine(Environment.SystemDirectory,"vmconnect.exe");
            if(!System.IO.File.Exists(executable))throw new InvalidOperationException("VMConnect is not installed on this Windows host.");
            // Connect by GUID: per-VM authorization is sufficient even when the
            // unelevated user's VM inventory/name enumeration is restricted.
            var info=new ProcessStartInfo(executable,"localhost -G "+resolved.ToString("D"));
            info.UseShellExecute=false;info.CreateNoWindow=true;info.WindowStyle=ProcessWindowStyle.Hidden;
            vmName=name;oldForeground=GetForegroundWindow();
            vmProcess=Process.Start(info);
            if(vmProcess==null)throw new InvalidOperationException("VMConnect did not launch.");
            IntPtr observed=IntPtr.Zero;
            var until=DateTime.UtcNow.AddSeconds(12);
            do{
                try{if(vmProcess.HasExited)break;}catch{break;}
                observed=FindConnectWindow(vmProcess.Id,name);
                if(observed!=IntPtr.Zero){
                    if(IsErrorDialog(observed)){observed=IntPtr.Zero;}
                    else break;
                }
                Thread.Sleep(95);
            }while(DateTime.UtcNow<until);
            if(observed==IntPtr.Zero){
                try{vmProcess.Kill();}catch{}
                throw new InvalidOperationException("VMConnect did not create a usable desktop window. No viewer was attached.");
            }
            // Keep the new viewer non-activating while moving it under BLACKICE.
            ShowWindow(observed,0);
            int priorStyle=GetWindowLongW(observed,-16);
            int childStyle=(priorStyle|WS_CHILD)&~(WS_POPUP|WS_CAPTION|WS_THICKFRAME|WS_SYSMENU|WS_MINIMIZEBOX|WS_MAXIMIZEBOX);
            SetWindowLongW(observed,-16,childStyle);
            SetLastError(0);
            IntPtr previous=SetParent(observed,host);
            int error=Marshal.GetLastWin32Error();
            if((previous==IntPtr.Zero&&error!=0)||GetParent(observed)!=host){
                SetWindowLongW(observed,-16,priorStyle);
                try{vmProcess.Kill();}catch{}
                throw new Win32Exception(error,"VMConnect could not become a BLACKICE child window.");
            }
            guestWindow=observed;parentWindow=host;
            // Model controls the guest by default. Its embedded viewer is visible
            // but never takes guest keyboard/mouse input until Take Control.
            inputEnabled=false;EnableWindow(guestWindow,false);
            shown=true;
            Position(x,y,width,height);
            foregroundUnaffected=SameForeground(oldForeground);
            if(!foregroundUnaffected){
                Close();
                throw new InvalidOperationException("VMConnect changed the foreground application. Native console launch was cancelled.");
            }
            return Status();
        }
    }
    public static object Position(int x,int y,int width,int height){
        lock(gate){
            if(guestWindow==IntPtr.Zero||!IsWindow(guestWindow)||GetParent(guestWindow)!=parentWindow)
                throw new InvalidOperationException("The embedded VMConnect window is no longer available.");
            Bounds(parentWindow,x,y,width,height);
            lastX=x;lastY=y;lastWidth=width;lastHeight=height;
            IntPtr before=GetForegroundWindow();
            uint flags=SWP_NOACTIVATE|SWP_FRAMECHANGED|SWP_NOSENDCHANGING;
            if(shown)flags|=SWP_SHOWWINDOW;
            if(!SetWindowPos(guestWindow,IntPtr.Zero,x,y,width,height,flags))
                throw new Win32Exception(Marshal.GetLastWin32Error(),"VMConnect viewport resize failed.");
            if(shown)ShowWindow(guestWindow,8);
            foregroundUnaffected=SameForeground(before);
            return Status();
        }
    }
    public static object Visible(bool value){
        lock(gate){
            if(guestWindow==IntPtr.Zero||!IsWindow(guestWindow))return Status();
            IntPtr before=GetForegroundWindow();
            shown=value;
            ShowWindow(guestWindow,value?8:0);
            foregroundUnaffected=SameForeground(before);
            return Status();
        }
    }
    public static object Input(bool value){
        lock(gate){
            if(guestWindow==IntPtr.Zero||!IsWindow(guestWindow))return Status();
            IntPtr before=GetForegroundWindow();
            inputEnabled=value;
            int style=GetWindowLongW(guestWindow,GWL_EXSTYLE);
            SetWindowLongW(guestWindow,GWL_EXSTYLE,value?(style&~WS_EX_NOACTIVATE):(style|WS_EX_NOACTIVATE));
            EnableWindow(guestWindow,value);
            foregroundUnaffected=SameForeground(before);
            return Status();
        }
    }
    public static object Close(){
        lock(gate){
            if(guestWindow!=IntPtr.Zero&&IsWindow(guestWindow)){
                ShowWindow(guestWindow,0);
                PostMessageW(guestWindow,0x0010,IntPtr.Zero,IntPtr.Zero);
            }
            if(vmProcess!=null){
                try{
                    if(!vmProcess.WaitForExit(1700))vmProcess.Kill();
                }catch{}
                vmProcess.Dispose();
            }
            vmProcess=null;guestWindow=IntPtr.Zero;parentWindow=IntPtr.Zero;shown=false;inputEnabled=false;
            return new {connected=false,viewerClosed=true,vmPreserved=true};
        }
    }
}
