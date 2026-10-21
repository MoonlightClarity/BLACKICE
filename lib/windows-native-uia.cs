// Native UIA2 is required for background automation: managed UIA has no AutoSetFocus switch.
// Import the installed Windows type library in memory; no SDK, generated binary or external package is required.
// https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_autosetfocus
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class RelayNativeUia {
    [DllImport("oleaut32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    private static extern void LoadTypeLibEx(string file, int kind, out ITypeLib typeLibrary);
    private class ImportSink : ITypeLibImporterNotifySink {
        public void ReportEvent(ImporterEventKind kind, int code, string message) {}
        public Assembly ResolveRef(object library) { throw new NotSupportedException("Unexpected external Windows automation type library reference."); }
    }
    private static Assembly interop;
    private static object client;
    private static void Initialize() {
        if (client != null) return;
        ITypeLib library;
        LoadTypeLibEx(Path.Combine(Environment.SystemDirectory, "UIAutomationCore.dll"), 2, out library);
        try {
            interop = new TypeLibConverter().ConvertTypeLibToAssembly(library, "RelayNativeUIA.Interop.dll", TypeLibImporterFlags.None, new ImportSink(), null, null, "RelayNativeUIA", null);
        } finally { Marshal.ReleaseComObject(library); }
        var instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
        try {
            Call("IUIAutomation2", "set_AutoSetFocus", instance, 0);
            Call("IUIAutomation2", "set_ConnectionTimeout", instance, 5000U);
            Call("IUIAutomation2", "set_TransactionTimeout", instance, 5000U);
            if (Convert.ToBoolean(Call("IUIAutomation2", "get_AutoSetFocus", instance))) throw new InvalidOperationException("Windows automation did not disable automatic focus.");
            client = instance;
        } catch { Marshal.ReleaseComObject(instance); throw; }
    }
    private static object Call(string contract, string method, object target, params object[] values) {
        var type = interop.GetType("RelayNativeUIA." + contract, true);
        var member = type.GetMethod(method);
        if (member == null) throw new MissingMethodException(contract, method);
        var parameters = member.GetParameters();
        for (int index = 0; index < values.Length; index++) {
            var parameterType = parameters[index].ParameterType;
            if (parameterType.IsEnum && values[index] != null) values[index] = Enum.ToObject(parameterType, values[index]);
        }
        try { return member.Invoke(target, values); }
        catch (TargetInvocationException error) { throw error.InnerException ?? error; }
    }
    public static object Element(string windowId, int[] runtimeId) {
        Initialize();
        var root = Call("IUIAutomation", "ElementFromHandle", client, new IntPtr(Int64.Parse(windowId)));
        object condition = null, element = null;
        try {
            condition = Call("IUIAutomation", "CreatePropertyCondition", client, 30000, runtimeId);
            element = Call("IUIAutomationElement", "FindFirst", root, 5, condition);
            if (element == null) throw new InvalidOperationException("This accessibility element is stale. Inspect the target window again.");
            var actual = (int[])Call("IUIAutomationElement", "GetRuntimeId", element);
            if (String.Join(".", actual) != String.Join(".", runtimeId)) throw new InvalidOperationException("Windows returned a different accessibility element. Inspect the window again.");
            return element;
        } catch { if (element != null) Marshal.ReleaseComObject(element); throw; }
        finally { if (condition != null) Marshal.ReleaseComObject(condition); Marshal.ReleaseComObject(root); }
    }
    public static void Act(string action, string windowId, int[] runtimeId, string value, string direction, int amount, string unit) {
        object element = Element(windowId, runtimeId), pattern = null;
        try {
            int id;
            switch (action) {
                case "invoke": id=10000; break;
                case "set_value": id=10002; break;
                case "select": id=10010; break;
                case "toggle": id=10015; break;
                case "expand": case "collapse": id=10005; break;
                case "scroll": id=10004; break;
                case "scroll_into_view": id=10017; break;
                case "set_range_value": id=10003; break;
                default: throw new ArgumentException("Unsupported background accessibility action.");
            }
            pattern = Call("IUIAutomationElement", "GetCurrentPattern", element, id);
            if (pattern == null) throw new InvalidOperationException("The requested accessibility pattern is no longer available. Inspect the control again.");
            switch (action) {
                case "invoke": Call("IUIAutomationInvokePattern", "Invoke", pattern); break;
                case "set_value": Call("IUIAutomationValuePattern", "SetValue", pattern, value); break;
                case "set_range_value": Call("IUIAutomationRangeValuePattern", "SetValue", pattern, Double.Parse(value, System.Globalization.CultureInfo.InvariantCulture)); break;
                case "select": Call("IUIAutomationSelectionItemPattern", "Select", pattern); break;
                case "toggle": Call("IUIAutomationTogglePattern", "Toggle", pattern); break;
                case "expand": Call("IUIAutomationExpandCollapsePattern", "Expand", pattern); break;
                case "collapse": Call("IUIAutomationExpandCollapsePattern", "Collapse", pattern); break;
                case "scroll_into_view": Call("IUIAutomationScrollItemPattern", "ScrollIntoView", pattern); break;
                case "scroll":
                    bool horizontal=direction=="left" || direction=="right";
                    // Native ScrollAmount: large decrement=0, small decrement=1, no amount=2, large increment=3, small increment=4.
                    int delta=(direction=="up" || direction=="left") ? (unit=="small" ? 1 : 0) : (unit=="small" ? 4 : 3);
                    for(int index=0;index<amount;index++) Call("IUIAutomationScrollPattern", "Scroll", pattern, horizontal ? delta : 2, horizontal ? 2 : delta);
                    break;
            }
        } finally { if (pattern != null) Marshal.ReleaseComObject(pattern); Marshal.ReleaseComObject(element); }
    }
}
