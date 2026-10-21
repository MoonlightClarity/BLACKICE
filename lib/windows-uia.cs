// UIA control patterns are the only mutation path. This helper never synthesizes input or focuses a window.
// References: https://learn.microsoft.com/dotnet/framework/ui-automation/ui-automation-control-patterns-overview
// https://learn.microsoft.com/dotnet/framework/ui-automation/obtaining-ui-automation-elements
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class RelayDesktop {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    public class WindowInfo {
        public string handle, title; public uint pid; public bool foreground; public int x, y, width, height;
    }
    public class Bounds { public double x, y, width, height; }
    public class RangeInfo { public double minimum, maximum, smallChange, largeChange; }
    public class ScrollInfo { public bool horizontal, vertical; public double horizontalPercent, verticalPercent; }
    public class ElementInfo {
        public string @ref, parentRef, windowId, name, automationId, controlType, className, frameworkId;
        public string value, toggleState, expandCollapseState;
        public int depth, processId; public bool enabled, offscreen, password, readOnly;
        public bool? selected;
        public Bounds bounds;
        public RangeInfo range;
        public ScrollInfo scroll;
        public string[] actions;
        public string[] limitations;
    }
    public class Inspection {
        public string windowId, rootRef, mode = "background_uia";
        public List<ElementInfo> elements = new List<ElementInfo>();
        public int visited; public bool truncated;
    }
    public class InputState { public string foreground; public int x, y; }
    private class Reference {
        public AutomationElement element;
        public string runtimeKey, rootKey, windowId;
        public int processId;
    }
    private class QueueItem { public AutomationElement element; public string parentRef; public int depth; }
    private static readonly string session = Guid.NewGuid().ToString("N").Substring(0, 12);
    private static int nextRef;
    private static readonly Dictionary<string, Reference> references = new Dictionary<string, Reference>();
    private static readonly Dictionary<string, string> runtimeRefs = new Dictionary<string, string>();
    public static string LastActionMechanism;

    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowStyle(IntPtr hwnd, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="SendMessageTimeoutW")]
    private static extern IntPtr ControlMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="SendMessageTimeoutW")]
    private static extern IntPtr ControlText(IntPtr hwnd, uint message, UIntPtr wParam, [MarshalAs(UnmanagedType.LPWStr)] string text, uint flags, uint timeout, out UIntPtr result);

    // Classic multiline Edit/RichEdit controls expose TextPattern without
    // ValuePattern. Their documented WM_SETTEXT operation remains available
    // without keyboard input. Limit this path to known native control classes,
    // matching process ownership and the ES_READONLY style on the current HWND.
    private static bool NativeTextControl(AutomationElement element, out bool readOnly) {
        readOnly = true;
        var handle = element.Current.NativeWindowHandle;
        if (handle == 0) return false;
        var hwnd = new IntPtr(handle); uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (!IsWindow(hwnd) || pid != element.Current.ProcessId) throw new InvalidOperationException("The native text control changed. Inspect the application again.");
        var name = new StringBuilder(256); GetClassName(hwnd, name, name.Capacity);
        var kind = name.ToString();
        bool native = kind.Equals("Edit", StringComparison.OrdinalIgnoreCase) || kind.Equals("RICHEDIT", StringComparison.OrdinalIgnoreCase) || kind.Equals("RichEdit20A", StringComparison.OrdinalIgnoreCase) || kind.Equals("RichEdit20W", StringComparison.OrdinalIgnoreCase) || kind.Equals("RICHEDIT50W", StringComparison.OrdinalIgnoreCase) || kind.Equals("RichEditD2DPT", StringComparison.OrdinalIgnoreCase);
        if (!native) return false;
        readOnly = (GetWindowStyle(hwnd, -16) & 0x0800) != 0;
        return true;
    }

    // Standard HWND controls can activate their app from the stock accessibility provider.
    // Target their semantic control protocol instead. These are control notifications, never
    // keyboard/mouse messages. No foreground, pointer, input queue, or clipboard is touched.
    private static bool BackgroundControl(string action, AutomationElement element, string value) {
        var nativeHandle = element.Current.NativeWindowHandle;
        if (nativeHandle == 0) return false;
        var hwnd = new IntPtr(nativeHandle);
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (pid != element.Current.ProcessId || !IsWindow(hwnd)) throw new InvalidOperationException("The native control changed. Inspect the application again.");
        var builder = new StringBuilder(256); GetClassName(hwnd, builder, builder.Capacity);
        var className = builder.ToString();
        bool winForms = className.StartsWith("WindowsForms10.", StringComparison.OrdinalIgnoreCase);
        bool edit = className.Equals("Edit", StringComparison.OrdinalIgnoreCase) || className.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) || (winForms && className.StartsWith("WindowsForms10.EDIT", StringComparison.OrdinalIgnoreCase));
        UIntPtr result;
        if (action == "set_value" && edit) {
            if ((GetWindowStyle(hwnd, -16) & 0x0800) != 0) throw new InvalidOperationException("The native text control is read-only.");
            if (ControlText(hwnd, 0x000C, UIntPtr.Zero, value, 0x0003, 3000, out result) == IntPtr.Zero)
                throw new InvalidOperationException("The background edit operation timed out or was blocked. Inspect the value before retrying; no physical-input fallback was used.");
            if (result == UIntPtr.Zero) throw new InvalidOperationException("The application rejected its background text value.");
            LastActionMechanism = "hwnd_edit_value"; return true;
        }
        bool button = className.Equals("Button", StringComparison.OrdinalIgnoreCase) || (winForms && className.StartsWith("WindowsForms10.BUTTON", StringComparison.OrdinalIgnoreCase));
        if (action == "toggle" && winForms && button)
            throw new InvalidOperationException("This stock WinForms checkbox provider activates its window and cannot update its managed state through background control messages. Use an application integration; physical-input and focus-taking fallbacks are disabled.");
        if ((action == "invoke" || action == "toggle") && button) {
            var parent = GetParent(hwnd);
            if (parent == IntPtr.Zero) throw new InvalidOperationException("The background button has no parent notification target. Inspect the application again.");
            // WM_COMMAND / BN_CLICKED is the standard button-to-parent notification.
            // WinForms reflects it to the owning Button/CheckBox and runs normal click logic.
            // BM_CLICK is deliberately avoided: stock controls can focus the window from it.
            var controlId = unchecked((uint)GetDlgCtrlID(hwnd)) & 0xffffU;
            if (action == "toggle") {
                object toggle;
                if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out toggle)) throw Unsupported(action);
                var state = ((TogglePattern)toggle).Current.ToggleState;
                var style = GetWindowStyle(hwnd, -16) & 0xf;
                bool threeState = style == 5 || style == 6;
                uint nextState = (uint)(((int)state + 1) % (threeState ? 3 : 2));
                if (ControlMessage(hwnd, 0x00F1, new UIntPtr(nextState), IntPtr.Zero, 0x0003, 3000, out result) == IntPtr.Zero)
                    throw new InvalidOperationException("The application rejected the background checkbox state. Inspect before retrying.");
            }
            if (ControlMessage(parent, 0x0111, new UIntPtr(controlId), hwnd, 0x0003, 3000, out result) == IntPtr.Zero)
                throw new InvalidOperationException("The background button notification timed out or was blocked. Inspect the result before retrying; no physical-input fallback was used.");
            LastActionMechanism = "hwnd_button_notification"; return true;
        }
        return false;
    }

    public static void EnableDpi() {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    }
    public static InputState ObserveInput() {
        POINT point; GetCursorPos(out point);
        return new InputState { foreground = GetForegroundWindow().ToInt64().ToString(), x = point.X, y = point.Y };
    }
    public static List<WindowInfo> Windows() {
        var result = new List<WindowInfo>();
        IntPtr foreground = GetForegroundWindow();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (!IsWindowVisible(hwnd)) return true;
            var title = new StringBuilder(513);
            if (GetWindowText(hwnd, title, title.Capacity) == 0) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            RECT bounds; if (!GetWindowRect(hwnd, out bounds)) return true;
            result.Add(new WindowInfo { handle = hwnd.ToInt64().ToString(), title = title.ToString(), pid = pid,
                foreground = hwnd == foreground, x = bounds.Left, y = bounds.Top,
                width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top });
            return result.Count < 2000;
        }, IntPtr.Zero);
        return result;
    }
    private static string RuntimeKey(AutomationElement element) {
        return element.Current.ProcessId.ToString() + ":" + String.Join(".", element.GetRuntimeId());
    }
    private static AutomationElement Window(string windowId) {
        long number;
        if (!Int64.TryParse(windowId, out number) || number <= 0 || !IsWindow(new IntPtr(number)))
            throw new InvalidOperationException("The window is no longer available. List windows again.");
        var root = AutomationElement.FromHandle(new IntPtr(number));
        if (root == null) throw new InvalidOperationException("This window does not expose a UI Automation root. Use an application or browser integration that supports it.");
        return root;
    }
    private static string Remember(AutomationElement element, string windowId, string rootKey) {
        var key = windowId + ":" + RuntimeKey(element);
        string existing;
        if (runtimeRefs.TryGetValue(key, out existing)) {
            Reference previous;
            if (references.TryGetValue(existing, out previous)) {
                try { if (Automation.Compare(previous.element, element)) return existing; } catch (ElementNotAvailableException) {}
            }
            references.Remove(existing); runtimeRefs.Remove(key);
        }
        var id = "uia_" + session + "_" + (++nextRef).ToString();
        references[id] = new Reference { element = element, runtimeKey = RuntimeKey(element), rootKey = rootKey, windowId = windowId, processId = element.Current.ProcessId };
        runtimeRefs[key] = id;
        return id;
    }
    private static Reference Resolve(string id) {
        Reference reference;
        if (String.IsNullOrEmpty(id) || !references.TryGetValue(id, out reference))
            throw new InvalidOperationException("Unknown or expired accessibility ref. Inspect the target window again; refs expire when the desktop worker reconnects.");
        try {
            var root = Window(reference.windowId);
            if (RuntimeKey(root) != reference.rootKey || RuntimeKey(reference.element) != reference.runtimeKey || reference.element.Current.ProcessId != reference.processId)
                throw new ElementNotAvailableException();
            var ancestor = reference.element;
            bool contained = false;
            for (int depth = 0; ancestor != null && depth < 50; depth++) {
                if (Automation.Compare(ancestor, root)) { contained = true; break; }
                ancestor = TreeWalker.ControlViewWalker.GetParent(ancestor);
            }
            if (!contained) throw new ElementNotAvailableException();
            return reference;
        } catch (ElementNotAvailableException) {
            references.Remove(id);
            throw new InvalidOperationException("This accessibility element is stale or moved to a different window. Inspect the target window again before acting.");
        }
    }
    private static bool Pattern(AutomationElement element, AutomationPattern kind, out object pattern) {
        return element.TryGetCurrentPattern(kind, out pattern);
    }
    private static bool KnownFocusTakingToggle(AutomationElement element) {
        var hwnd = element.Current.NativeWindowHandle;
        if (hwnd == 0) return false;
        var name = new StringBuilder(256); GetClassName(new IntPtr(hwnd), name, name.Capacity);
        return name.ToString().StartsWith("WindowsForms10.BUTTON", StringComparison.OrdinalIgnoreCase);
    }
    private static ElementInfo Describe(AutomationElement element, string windowId, string rootKey, string parentRef, int depth) {
        var current = element.Current;
        var bounds = current.BoundingRectangle;
        var result = new ElementInfo {
            @ref = Remember(element, windowId, rootKey), parentRef = parentRef, windowId = windowId,
            name = Short(current.Name, 500), automationId = Short(current.AutomationId, 200),
            controlType = current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            className = Short(current.ClassName, 200), frameworkId = current.FrameworkId,
            enabled = current.IsEnabled, offscreen = current.IsOffscreen, password = current.IsPassword,
            processId = current.ProcessId, depth = depth,
            bounds = new Bounds { x = Finite(bounds.X), y = Finite(bounds.Y), width = Finite(bounds.Width), height = Finite(bounds.Height) }
        };
        var actions = new List<string> { "inspect" };
        object pattern;
        if (Pattern(element, InvokePattern.Pattern, out pattern)) actions.Add("invoke");
        if (Pattern(element, ValuePattern.Pattern, out pattern)) {
            var value = ((ValuePattern)pattern).Current;
            result.readOnly = value.IsReadOnly;
            if (!current.IsPassword) result.value = Short(value.Value, 2000);
            if (!value.IsReadOnly) actions.Add("set_value");
            if (!current.IsPassword) actions.Add("get_text");
        } else if (Pattern(element, RangeValuePattern.Pattern, out pattern)) {
            var value = ((RangeValuePattern)pattern).Current;
            result.readOnly = value.IsReadOnly; result.value = value.Value.ToString(CultureInfo.InvariantCulture);
            result.range = new RangeInfo { minimum=Finite(value.Minimum), maximum=Finite(value.Maximum), smallChange=Finite(value.SmallChange), largeChange=Finite(value.LargeChange) };
            if (!value.IsReadOnly) actions.Add("set_value");
        }
        if (Pattern(element, TextPattern.Pattern, out pattern) && !current.IsPassword && !actions.Contains("get_text")) actions.Add("get_text");
        bool nativeReadOnly;
        if (NativeTextControl(element, out nativeReadOnly)) {
            result.readOnly = result.readOnly || nativeReadOnly;
            if (result.readOnly) actions.Remove("set_value");
            else if (!actions.Contains("set_value")) actions.Add("set_value");
        }
        if (Pattern(element, SelectionItemPattern.Pattern, out pattern)) {
            result.selected = ((SelectionItemPattern)pattern).Current.IsSelected; actions.Add("select");
        }
        if (Pattern(element, TogglePattern.Pattern, out pattern)) {
            result.toggleState = ((TogglePattern)pattern).Current.ToggleState.ToString();
            if (KnownFocusTakingToggle(element)) result.limitations = new string[] { "WinForms checkbox toggle is unavailable in background mode because its provider activates the window. Use a dedicated application integration." };
            else actions.Add("toggle");
        }
        if (Pattern(element, ExpandCollapsePattern.Pattern, out pattern)) {
            result.expandCollapseState = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString();
            if (((ExpandCollapsePattern)pattern).Current.ExpandCollapseState != ExpandCollapseState.LeafNode) { actions.Add("expand"); actions.Add("collapse"); }
        }
        if (Pattern(element, ScrollPattern.Pattern, out pattern)) {
            var scroll=((ScrollPattern)pattern).Current;
            result.scroll=new ScrollInfo { horizontal=scroll.HorizontallyScrollable, vertical=scroll.VerticallyScrollable, horizontalPercent=Finite(scroll.HorizontalScrollPercent), verticalPercent=Finite(scroll.VerticalScrollPercent) };
            if (scroll.HorizontallyScrollable || scroll.VerticallyScrollable) actions.Add("scroll");
        }
        if (Pattern(element, ScrollItemPattern.Pattern, out pattern)) actions.Add("scroll_into_view");
        result.actions = actions.ToArray();
        return result;
    }
    private static string Short(string value, int max) { return value == null ? "" : value.Length <= max ? value : value.Substring(0, max); }
    private static double Finite(double value) { return Double.IsNaN(value) || Double.IsInfinity(value) ? 0 : value; }
    public static Inspection Inspect(string windowId, string id, int maxDepth, int maxNodes, string query) {
        if (maxDepth < 0 || maxDepth > 10 || maxNodes < 1 || maxNodes > 300) throw new ArgumentException("Invalid inspection bounds.");
        AutomationElement start; string rootKey;
        if (!String.IsNullOrEmpty(id)) { var reference = Resolve(id); start = reference.element; windowId = reference.windowId; rootKey = reference.rootKey; }
        else { start = Window(windowId); rootKey = RuntimeKey(start); }
        // Keep references bounded. A fresh inspection after expiry deliberately invalidates old refs.
        if (references.Count > 5000) { references.Clear(); runtimeRefs.Clear(); }
        var result = new Inspection { windowId = windowId };
        var queue = new Queue<QueueItem>();
        queue.Enqueue(new QueueItem { element = start, depth = 0 });
        while (queue.Count > 0 && result.visited < maxNodes) {
            var item = queue.Dequeue();
            try {
                var info = Describe(item.element, windowId, rootKey, item.parentRef, item.depth);
                result.visited++;
                if (item.depth == 0) result.rootRef = info.@ref;
                if (item.depth == 0 || String.IsNullOrEmpty(query) || info.name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || info.automationId.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || info.controlType.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) result.elements.Add(info);
                if (item.depth >= maxDepth) {
                    if (TreeWalker.ControlViewWalker.GetFirstChild(item.element) != null) result.truncated = true;
                    continue;
                }
                var child = TreeWalker.ControlViewWalker.GetFirstChild(item.element);
                while (child != null) {
                    if (queue.Count + result.visited >= maxNodes) { result.truncated = true; break; }
                    queue.Enqueue(new QueueItem { element = child, parentRef = info.@ref, depth = item.depth + 1 });
                    child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                }
            } catch (ElementNotAvailableException) { result.truncated = true; }
        }
        result.truncated = result.truncated || queue.Count > 0;
        return result;
    }
    public static string ReadText(string id, int maxCharacters) {
        var element = Resolve(id).element;
        if (element.Current.IsPassword) throw new InvalidOperationException("Password values are not exposed by accessibility inspection.");
        if (maxCharacters < 1 || maxCharacters > 12000) throw new ArgumentException("Invalid text bound.");
        object pattern;
        if (Pattern(element, TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(maxCharacters);
        if (Pattern(element, ValuePattern.Pattern, out pattern)) return Short(((ValuePattern)pattern).Current.Value, maxCharacters);
        throw Unsupported("get_text");
    }
    private static InvalidOperationException Unsupported(string action) {
        return new InvalidOperationException("This control does not support the " + action + " accessibility pattern. Inspect it again and use only its advertised actions, or use a dedicated application/browser integration. No physical-input fallback is available.");
    }
    public static void Act(string action, string id, string value, string direction, int amount, string unit) {
        var reference = Resolve(id);
        var element = reference.element;
        if (!element.Current.IsEnabled) throw new InvalidOperationException("The accessibility control is disabled. Inspect the application state before retrying.");
        LastActionMechanism = "uia2_no_auto_focus";
        object pattern;
        switch (action) {
            case "invoke":
                if (!Pattern(element, InvokePattern.Pattern, out pattern)) throw Unsupported(action);
                if (BackgroundControl(action, element, value)) return;
                RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
            case "set_value":
                if (value == null || value.Length > 10000 || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid value.");
                if (Pattern(element, ValuePattern.Pattern, out pattern)) {
                    var provider = (ValuePattern)pattern;
                    if (provider.Current.IsReadOnly) throw new InvalidOperationException("This accessibility value is read-only.");
                    if (BackgroundControl(action, element, value)) return;
                    RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
                }
                if (Pattern(element, RangeValuePattern.Pattern, out pattern)) {
                    var provider = (RangeValuePattern)pattern;
                    double number;
                    if (!Double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number) || Double.IsNaN(number) || Double.IsInfinity(number)) throw new ArgumentException("This control requires a finite numeric value.");
                    if (provider.Current.IsReadOnly || number < provider.Current.Minimum || number > provider.Current.Maximum) throw new ArgumentException("The numeric value is read-only or outside the advertised control range.");
                    RelayNativeUia.Act("set_range_value", reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
                }
                bool nativeReadOnly;
                if (NativeTextControl(element, out nativeReadOnly)) {
                    if (nativeReadOnly) throw new InvalidOperationException("The native text control is read-only.");
                    if (BackgroundControl(action, element, value)) return;
                }
                throw Unsupported(action);
            case "select":
                if (!Pattern(element, SelectionItemPattern.Pattern, out pattern)) throw Unsupported(action);
                RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
            case "toggle":
                if (!Pattern(element, TogglePattern.Pattern, out pattern)) throw Unsupported(action);
                if (BackgroundControl(action, element, value)) return;
                RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
            case "expand": case "collapse":
                if (!Pattern(element, ExpandCollapsePattern.Pattern, out pattern)) throw Unsupported(action);
                RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
            case "scroll_into_view":
                if (!Pattern(element, ScrollItemPattern.Pattern, out pattern)) throw Unsupported(action);
                RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit); return;
            case "scroll":
                if (!Pattern(element, ScrollPattern.Pattern, out pattern)) throw Unsupported(action);
                if (amount < 1 || amount > 10 || (unit != "small" && unit != "large")) throw new ArgumentException("Invalid scroll amount.");
                if (direction != "up" && direction != "down" && direction != "left" && direction != "right") throw new ArgumentException("Invalid scroll direction.");
                var scroll = (ScrollPattern)pattern;
                bool horizontal = direction == "left" || direction == "right";
                if (horizontal ? !scroll.Current.HorizontallyScrollable : !scroll.Current.VerticallyScrollable) throw new InvalidOperationException("This control cannot scroll on the requested axis.");
                RelayNativeUia.Act(action, reference.windowId, element.GetRuntimeId(), value, direction, amount, unit);
                return;
            default: throw Unsupported(action);
        }
    }
}
