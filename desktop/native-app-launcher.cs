using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Startup hints only: applications may subsequently activate their own windows,
// and Windows security/consent UI remains under Windows' control. No alternate
// desktop, token, profile, hidden-app flag or foreground-restoration loop.
public static class BlackiceApplicationLauncher {
    public const ushort ShowNoActivate = 4; // SW_SHOWNOACTIVATE
    public const uint UseShowWindow = 1; // STARTF_USESHOWWINDOW
    public const uint NewConsole = 0x10; // Console apps get their own visible console.
    public const uint ShellProcessHandle = 0x40, ShellSynchronous = 0x100, ShellInvokeItem = 0x0c;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo {
        public uint cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reservedBytes; public IntPtr reservedData, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ShellInfo {
        public uint cbSize, mask; public IntPtr hwnd; public string verb, file, parameters, directory;
        public int show; public IntPtr instance, itemIdList; public string className;
        public IntPtr classKey; public uint hotKey; public IntPtr iconOrMonitor, process;
    }
    public class Receipt { public bool launched = true, activationRequested = true; public int pid, activationPid; public string activationProcessStartedAt; }
    public interface ILaunchIdentityApi { string StartedAt(IntPtr process); }

    // The injectable boundary lets regressions inspect the actual native
    // structures and returned handles without starting any application.
    public interface ILaunchApi {
        bool CreateProcess(string executable, StringBuilder commandLine, uint flags, string directory, ref StartupInfo startup, out ProcessInfo process);
        bool ShellExecute(ref ShellInfo info);
        IntPtr ParseShellItem(string name);
        uint ProcessId(IntPtr process);
        void Close(IntPtr handle);
        void FreeShellItem(IntPtr item);
        int LastError { get; }
    }
    private sealed class WindowsLaunchApi : ILaunchApi, ILaunchIdentityApi {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(string executable, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShellExecuteExW(ref ShellInfo info);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int SHParseDisplayName(string name, IntPtr bindContext, out IntPtr item, uint attributes, out uint actualAttributes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
        public bool CreateProcess(string executable, StringBuilder commandLine, uint flags, string directory, ref StartupInfo startup, out ProcessInfo process) {
            // Null environment/desktop/security attributes retain the normal
            // calling user's environment, interactive desktop and permissions.
            return CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, directory, ref startup, out process);
        }
        public bool ShellExecute(ref ShellInfo info) { return ShellExecuteExW(ref info); }
        public IntPtr ParseShellItem(string name) { IntPtr item; uint attributes; Marshal.ThrowExceptionForHR(SHParseDisplayName(name, IntPtr.Zero, out item, 0, out attributes)); return item; }
        public uint ProcessId(IntPtr process) { return GetProcessId(process); }
        public string StartedAt(IntPtr process) {long created,exited,kernel,user;return process!=IntPtr.Zero&&GetProcessTimes(process,out created,out exited,out kernel,out user)?DateTime.FromFileTimeUtc(created).ToString("O"):null;}
        public void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }
        public void FreeShellItem(IntPtr item) { if (item != IntPtr.Zero) Marshal.FreeCoTaskMem(item); }
        public int LastError { get { return Marshal.GetLastWin32Error(); } }
    }

    private static string QuoteArgument(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Application arguments must be text without null characters.");
        var quoted = new StringBuilder("\""); int backslashes = 0;
        foreach (char c in value) {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { quoted.Append('\\', backslashes * 2 + 1); quoted.Append('"'); }
            else { quoted.Append('\\', backslashes); quoted.Append(c); }
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2); quoted.Append('"'); return quoted.ToString();
    }
    public static Receipt Executable(string executable, string[] arguments, string directory) { return Executable(executable, arguments, directory, new WindowsLaunchApi()); }
    public static Receipt Executable(string executable, string[] arguments, string directory, ILaunchApi api) {
        if (String.IsNullOrWhiteSpace(executable) || !Path.IsPathRooted(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Select an installed Windows executable.");
        var command = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments ?? new string[0]) { command.Append(' '); command.Append(QuoteArgument(argument)); }
        if (command.Length >= 32767) throw new ArgumentException("Application command line is too long.");
        var startup = new StartupInfo { cb = (uint)Marshal.SizeOf(typeof(StartupInfo)), flags = UseShowWindow, showWindow = ShowNoActivate };
        ProcessInfo process;
        if (!api.CreateProcess(executable, command, NewConsole, directory, ref startup, out process)) throw new Win32Exception(api.LastError, "Windows could not start this application.");
        try { var identity=api as ILaunchIdentityApi;return new Receipt { pid = checked((int)process.processId),activationProcessStartedAt=identity==null?null:identity.StartedAt(process.process) }; }
        finally { api.Close(process.thread); api.Close(process.process); }
    }
    public static Receipt Shortcut(string path) { return Shortcut(path, new WindowsLaunchApi()); }
    public static Receipt Shortcut(string path, ILaunchApi api) {
        // Execute the validated .lnk itself. Do not rebuild its arguments or cwd.
        return Shell(new ShellInfo { file = path }, api);
    }
    public static Receipt AppsFolder(string appId) { return AppsFolder(appId, new WindowsLaunchApi()); }
    public static Receipt AppsFolder(string appId, ILaunchApi api) {
        var item = api.ParseShellItem("shell:AppsFolder\\" + appId);
        try { return Shell(new ShellInfo { mask = ShellInvokeItem, itemIdList = item }, api); }
        finally { api.FreeShellItem(item); }
    }
    private static Receipt Shell(ShellInfo info, ILaunchApi api) {
        info.cbSize = (uint)Marshal.SizeOf(typeof(ShellInfo));
        info.mask |= ShellProcessHandle | ShellSynchronous;
        info.show = ShowNoActivate;
        if (!api.ShellExecute(ref info)) throw new Win32Exception(api.LastError, "Windows could not activate this application.");
        try { var identity=api as ILaunchIdentityApi;return new Receipt { activationPid = info.process == IntPtr.Zero ? 0 : checked((int)api.ProcessId(info.process)),activationProcessStartedAt=identity==null?null:identity.StartedAt(info.process) }; }
        finally { api.Close(info.process); }
    }
}
