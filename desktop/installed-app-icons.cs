using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

// Read the application's own icon resource, or ask Windows for the exact Shell
// item (including AppsFolder identities). No application is activated here.
public static class InstalledApplicationIcons {
  [StructLayout(LayoutKind.Sequential)] struct Size { public int Width, Height; public Size(int n) { Width=n; Height=n; } }
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ImageFactory { void GetImage(Size size, uint flags, out IntPtr bitmap); }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out ImageFactory factory);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern uint ExtractIconEx(string path, int index, out IntPtr large, out IntPtr small, uint count);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [StructLayout(LayoutKind.Sequential)] struct BitmapHeader {
    public uint Size; public int Width, Height; public ushort Planes, BitCount;
    public uint Compression, ImageSize; public int XPels, YPels; public uint Used, Important;
  }
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] pixels, ref BitmapHeader header, uint usage);
  static string Encode(Bitmap bitmap) { using(var stream=new MemoryStream()) { bitmap.Save(stream,ImageFormat.Png); return "data:image/png;base64,"+Convert.ToBase64String(stream.ToArray()); } }
  static string Resource(string path, int index) {
    IntPtr large=IntPtr.Zero,small=IntPtr.Zero;
    try {
      if(String.IsNullOrWhiteSpace(path)||!File.Exists(path))return null;
      ExtractIconEx(path,index,out large,out small,1);
      IntPtr handle=large!=IntPtr.Zero?large:small;
      if(handle==IntPtr.Zero)return null;
      using(var icon=(Icon)Icon.FromHandle(handle).Clone()) using(var bitmap=icon.ToBitmap())return Encode(bitmap);
    } finally { if(large!=IntPtr.Zero)DestroyIcon(large);if(small!=IntPtr.Zero)DestroyIcon(small); }
  }
  static string ShellItem(string parsingName) {
    ImageFactory factory=null; IntPtr handle=IntPtr.Zero,dc=IntPtr.Zero;
    try {
      var iid=typeof(ImageFactory).GUID; SHCreateItemFromParsingName(parsingName,IntPtr.Zero,ref iid,out factory);
      factory.GetImage(new Size(48),0x5,out handle); // ICONONLY | BIGGERSIZEOK
      using(var shape=Image.FromHbitmap(handle)) {
        int width=shape.Width,height=shape.Height;
        var header=new BitmapHeader { Size=40,Width=width,Height=-height,Planes=1,BitCount=32 };
        var pixels=new byte[width*height*4];dc=GetDC(IntPtr.Zero);
        if(GetDIBits(dc,handle,0,(uint)height,pixels,ref header,0)==0)return null;
        bool alpha=false;for(int i=3;i<pixels.Length;i+=4)if(pixels[i]!=0){alpha=true;break;}
        if(!alpha)for(int i=3;i<pixels.Length;i+=4)pixels[i]=255;
        using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
          var data=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
          try {Marshal.Copy(pixels,0,data.Scan0,pixels.Length);}finally{bitmap.UnlockBits(data);}
          return Encode(bitmap);
        }
      }
    } finally {if(dc!=IntPtr.Zero)ReleaseDC(IntPtr.Zero,dc);if(handle!=IntPtr.Zero)DeleteObject(handle);if(factory!=null)Marshal.ReleaseComObject(factory);}
  }
  public static string Read(string sourcePath,string aumid,string iconPath,int iconIndex,string targetPath) {
    string image=null;
    try {image=Resource(iconPath,iconIndex);}catch{}
    if(image!=null)return image;
    try {image=ShellItem(!String.IsNullOrWhiteSpace(aumid)?@"shell:AppsFolder\"+aumid:sourcePath);}catch{}
    if(image!=null)return image;
    try {return Resource(targetPath,0);}catch{return null;}
  }
}
