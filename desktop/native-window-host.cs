using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class BlackiceNativeWindowHost {
    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    public class WindowInfo { public string id, title, process; public int pid; }
    public class HostInfo {
        public bool attached, visible, isolated = false;
        public string windowId, title, mode = "native_window";
        public int dialogCount;
    }
    private delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder buffer, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder buffer, int capacity);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
    [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] private static extern int SetWindowLongW(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);

    private const int WS_CHILD = 0x40000000, WS_CAPTION = 0x00c00000, WS_THICKFRAME = 0x00040000;
    private const int WS_POPUP = unchecked((int)0x80000000);
    private static IntPtr appWindow, blackiceWindow, previousParent;
    private static int previousStyle;
    private static Rect previousBounds, stage;
    private static bool visible = true;
    private static readonly Dictionary<long, IntPtr> dialogs = new Dictionary<long, IntPtr>();

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
    public static WindowInfo[] Windows(int excludedPid) {
        var result = new List<WindowInfo>();
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
            string process = "Application";
            try { using (var candidate = Process.GetProcessById((int)pid)) process = candidate.ProcessName; } catch {}
            result.Add(new WindowInfo { id = hwnd.ToInt64().ToString(), title = title, process = process, pid = (int)pid });
            return result.Count < 120;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static HostInfo Status() {
        bool attached = appWindow != IntPtr.Zero && IsWindow(appWindow);
        return new HostInfo { attached = attached, visible = attached && visible,
            windowId = attached ? appWindow.ToInt64().ToString() : null,
            title = attached ? Title(appWindow) : "", dialogCount = dialogs.Count };
    }
    public static HostInfo Attach(string application, string host, int x, int y, int width, int height) {
        Detach();
        IntPtr target = Parse(application), parent = Parse(host);
        if (target == parent || (GetWindowLongW(target, -16) & WS_CHILD) != 0)
            throw new ArgumentException("Choose an ordinary top-level application window, not an existing child.");
        uint pid, hostPid;
        GetWindowThreadProcessId(target, out pid); GetWindowThreadProcessId(parent, out hostPid);
        if (pid == 0 || pid == hostPid || pid == Process.GetCurrentProcess().Id)
            throw new ArgumentException("Cannot embed the BLACKICE window into itself.");
        Rect oldArea;
        if (!GetWindowRect(target, out oldArea)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int oldStyle = GetWindowLongW(target, -16);
        int childStyle = (oldStyle | WS_CHILD) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME;
        SetWindowLongW(target, -16, childStyle);
        SetLastError(0);
        IntPtr prior = SetParent(target, parent);
        if (prior == IntPtr.Zero && Marshal.GetLastWin32Error() != 0) {
            SetWindowLongW(target, -16, oldStyle);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows refused to embed the application");
        }
        appWindow = target; blackiceWindow = parent; previousParent = prior;
        previousStyle = oldStyle; previousBounds = oldArea; visible = true;
        try { return Position(x, y, width, height); }
        catch { Detach(); throw; }
    }
    private static bool OwnedDialog(IntPtr hwnd) {
        IntPtr next = hwnd;
        for (int i = 0; i < 12; i++) {
            next = GetWindow(next, 4);
            if (next == IntPtr.Zero) return false;
            if (next == appWindow) return true;
        }
        return false;
    }
    public static WindowInfo[] Dialogs() {
        var result = new List<WindowInfo>();
        if (appWindow == IntPtr.Zero || !IsWindow(appWindow)) return result.ToArray();
        Rect client;
        if (!GetClientRect(blackiceWindow, out client)) return result.ToArray();
        Point offset = new Point();
        if (!ClientToScreen(blackiceWindow, ref offset)) return result.ToArray();
        var valid = new HashSet<long>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (!OwnedDialog(hwnd)) return true;
            long id = hwnd.ToInt64();
            if (!IsWindowVisible(hwnd) && !dialogs.ContainsKey(id)) return true;
            valid.Add(id); dialogs[id] = hwnd;
            if (IsWindowVisible(hwnd) && visible) {
                Rect area;
                if (GetWindowRect(hwnd, out area) && area.Width > 0 && area.Height > 0) {
                    int left = Math.Max(offset.X, Math.Min(area.Left, offset.X + client.Width - area.Width));
                    int top = Math.Max(offset.Y, Math.Min(area.Top, offset.Y + client.Height - area.Height));
                    if (left != area.Left || top != area.Top)
                        SetWindowPos(hwnd, IntPtr.Zero, left, top, 0, 0, 0x0001 | 0x0004 | 0x0010);
                }
            }
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            result.Add(new WindowInfo { id = id.ToString(), title = Title(hwnd), process = "Dialog", pid = (int)pid });
            return result.Count < 64;
        }, IntPtr.Zero);
        var expired = new List<long>();
        foreach (var item in dialogs) if (!IsWindow(item.Value) || (!valid.Contains(item.Key) && visible)) expired.Add(item.Key);
        foreach (long id in expired) dialogs.Remove(id);
        return result.ToArray();
    }
    public static HostInfo Position(int x, int y, int width, int height) {
        if (appWindow == IntPtr.Zero || !IsWindow(appWindow) || !IsWindow(blackiceWindow))
            throw new InvalidOperationException("The embedded application is no longer available.");
        Rect client;
        if (!GetClientRect(blackiceWindow, out client)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (x < 0 || y < 0 || width < 80 || height < 60 || width > 10000 || height > 10000 || x + width > client.Width + 4 || y + height > client.Height + 4)
            throw new ArgumentException("Application bounds must remain inside BLACKICE.");
        stage = new Rect { Left = x, Top = y, Right = x + width, Bottom = y + height };
        if (!MoveWindow(appWindow, x, y, width, height, true)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Dialogs();
        return Status();
    }
    public static HostInfo SetVisible(bool show) {
        if (appWindow == IntPtr.Zero || !IsWindow(appWindow)) return Status();
        visible = show;
        ShowWindow(appWindow, show ? 8 : 0); // SW_SHOWNA: never activate from automatic surface updates
        foreach (var popup in dialogs.Values) if (IsWindow(popup)) ShowWindow(popup, show ? 8 : 0);
        if (show) Dialogs();
        return Status();
    }
    public static HostInfo Detach() {
        if (appWindow != IntPtr.Zero && IsWindow(appWindow)) {
            SetWindowLongW(appWindow, -16, previousStyle);
            SetParent(appWindow, previousParent);
            SetWindowPos(appWindow, IntPtr.Zero, previousBounds.Left, previousBounds.Top, Math.Max(1, previousBounds.Width), Math.Max(1, previousBounds.Height), 0x0004 | 0x0010 | 0x0020 | 0x0040); // SWP_NOACTIVATE
            ShowWindow(appWindow, 8); // SW_SHOWNA
        }
        foreach (var popup in dialogs.Values) if (IsWindow(popup)) ShowWindow(popup, 8);
        dialogs.Clear(); appWindow = IntPtr.Zero; blackiceWindow = IntPtr.Zero;
        previousParent = IntPtr.Zero; previousStyle = 0; visible = true;
        return Status();
    }
}
