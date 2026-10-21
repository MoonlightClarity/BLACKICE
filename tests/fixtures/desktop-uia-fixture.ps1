param([Parameter(Mandatory=$true)][string]$StateFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public class RelayUIAFixtureForm : Form {
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr CreateWindowEx(int exStyle,string className,string title,int style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam);
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { var value=base.CreateParams; value.ExStyle |= 0x08000000; return value; } }
    private readonly string stateFile;
    private readonly TextBox edit = new TextBox();
    private readonly CheckBox check = new CheckBox();
    private readonly ListBox list = new ListBox();
    private readonly TreeView tree = new TreeView();
    private readonly TreeNode parent = new TreeNode("Fixture parent");
    private readonly Timer timer = new Timer();
    private int clicks;
    private IntPtr nativeCheckbox;
    private readonly DateTime started=DateTime.UtcNow;
    public RelayUIAFixtureForm(string file) {
        stateFile=file; Text="Relay dedicated background UIA fixture"; Name="relayUiaFixture";
        AccessibleName="Relay dedicated background UIA fixture";
        StartPosition=FormStartPosition.Manual; Location=new Point(-15000,-15000); ClientSize=new Size(420,450);
        ShowInTaskbar=false; FormBorderStyle=FormBorderStyle.FixedToolWindow;
        edit.Name="fixtureEdit"; edit.AccessibleName="Fixture text field"; edit.SetBounds(12,12,380,28); edit.Text="Original value";
        var button=new Button(); button.Name="fixtureInvoke"; button.AccessibleName="Fixture apply"; button.Text="Apply"; button.SetBounds(12,52,130,30);
        button.Click += delegate { clicks++; Persist(); };
        check.Name="fixtureToggle"; check.AccessibleName="Fixture enabled"; check.Text="Enabled"; check.SetBounds(160,52,160,30);
        list.Name="fixtureList"; list.AccessibleName="Fixture choices"; list.SetBounds(12,100,180,120);
        for(int index=0;index<40;index++) list.Items.Add("Fixture option "+index);
        tree.Name="fixtureTree"; tree.AccessibleName="Fixture tree"; tree.SetBounds(210,100,180,120);
        parent.Nodes.Add(new TreeNode("Fixture child")); tree.Nodes.Add(parent);
        var readOnly=new TextBox(); readOnly.Name="fixtureReadOnly"; readOnly.AccessibleName="Fixture readonly"; readOnly.ReadOnly=true; readOnly.Text="Observed text"; readOnly.SetBounds(12,245,380,30);
        var custom=new Panel(); custom.Name="fixtureCustom"; custom.AccessibleName="Fixture unsupported canvas"; custom.SetBounds(12,295,380,100);
        Controls.AddRange(new Control[]{edit,button,check,list,tree,readOnly,custom});
        timer.Interval=50; timer.Tick += delegate { if(File.Exists(stateFile+".stop") || (DateTime.UtcNow-started).TotalSeconds>80) Close(); else Persist(); };
        Shown += delegate { nativeCheckbox=CreateWindowEx(0,"BUTTON","Fixture native checkbox",unchecked((int)0x50000003),12,405,350,30,Handle,new IntPtr(9001),IntPtr.Zero,IntPtr.Zero); Persist(); timer.Start(); };
        FormClosed += delegate { timer.Stop(); timer.Dispose(); };
    }
    private void Persist() {
        POINT point; GetCursorPos(out point);
        var state=new Dictionary<string,object>{
            {"pid",System.Diagnostics.Process.GetCurrentProcess().Id},{"handle",Handle.ToInt64().ToString()},
            {"foreground",GetForegroundWindow().ToInt64().ToString()},{"cursorX",point.X},{"cursorY",point.Y},
            {"text",edit.Text},{"clicks",clicks},{"checked",check.Checked},{"selected",list.SelectedIndex},{"topIndex",list.TopIndex},{"expanded",parent.IsExpanded}
        };
        state["nativeChecked"]=nativeCheckbox!=IntPtr.Zero && SendMessage(nativeCheckbox,0x00F0,IntPtr.Zero,IntPtr.Zero).ToInt64()!=0;
        try { File.WriteAllText(stateFile,new JavaScriptSerializer().Serialize(state)); } catch(IOException) {}
    }
    public static void Run(string stateFile) { Application.EnableVisualStyles(); Application.Run(new RelayUIAFixtureForm(stateFile)); }
}
'@ -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll')
[RelayUIAFixtureForm]::Run($StateFile)
