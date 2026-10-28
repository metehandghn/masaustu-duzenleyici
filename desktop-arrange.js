// Masaüstü simgelerini Windows'un kendi "Sıralama ölçütü" özelliğiyle düzenler.
// Explorer'ın masaüstü görünümüne (IFolderView2) COM üzerinden ulaşır; bu, masaüstünde
// sağ tık → Sıralama ölçütü → Ad/Öğe türü… seçmekle aynı şeydir. Dosyalara dokunmaz,
// sadece simgelerin yerini değiştirir.
const { spawn } = require('child_process');

const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Sequential)]
public struct SORTCOLUMN { public PROPERTYKEY propkey; public int direction; }

[ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
public interface IShellWindowsX {
  void _getCount(); void _Item(); void _NewEnum(); void _Register(); void _RegisterPending();
  void _Revoke(); void _OnNavigate(); void _OnActivated();
  [return: MarshalAs(UnmanagedType.IDispatch)]
  object FindWindowSW([MarshalAs(UnmanagedType.Struct)] ref object pvarLoc,
                      [MarshalAs(UnmanagedType.Struct)] ref object pvarLocRoot,
                      int swClass, out int pHwnd, int swfwOptions);
}

[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOleServiceProviderX {
  [PreserveSig] int QueryService(ref Guid guidService, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellBrowserX {
  void _GetWindow(); void _ContextSensitiveHelp();
  void _InsertMenusSB(); void _SetMenuSB(); void _RemoveMenusSB(); void _SetStatusTextSB();
  void _EnableModelessSB(); void _TranslateAcceleratorSB(); void _BrowseObject();
  void _GetViewStateStream(); void _GetControlWindow(); void _SendControlMsg();
  [PreserveSig] int QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)] out object ppshv);
}

[ComImport, Guid("1af3a467-214f-4298-908e-06b03e0b39f9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFolderView2X {
  // IFolderView
  void _GetCurrentViewMode(); void _SetCurrentViewMode(); void _GetFolder(); void _Item();
  void _ItemCount(); void _Items(); void _GetSelectionMarkedItem(); void _GetFocusedItem();
  void _GetItemPosition(); void _GetSpacing(); void _GetDefaultSpacing(); void _GetAutoArrange();
  void _SelectItem(); void _SelectAndPositionItems();
  // IFolderView2 (shobjidl_core.h sırası)
  void _SetGroupBy(); void _GetGroupBy(); void _SetViewProperty(); void _GetViewProperty();
  void _SetTileViewProperties(); void _SetExtendedTileViewProperties(); void _SetText();
  [PreserveSig] int SetCurrentFolderFlags(uint dwMask, uint dwFlags);
  [PreserveSig] int GetCurrentFolderFlags(out uint pdwFlags);
  [PreserveSig] int GetSortColumnCount(out int pcColumns);
  [PreserveSig] int SetSortColumns([In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] SORTCOLUMN[] rgSortColumns, int cColumns);
}

public static class DesktopArranger {
  const int SWC_DESKTOP = 8;
  const int SWFO_NEEDDISPATCH = 1;
  const uint FWF_AUTOARRANGE = 0x00000001;
  const uint FWF_SNAPTOGRID = 0x00080000;

  static void Check(int hr, string step) {
    if (hr < 0) throw new Exception(step + " başarısız (0x" + hr.ToString("X8") + ")");
  }

  static string step = "başlangıç";

  public static string Arrange(string mode, int auto) {
    try { return ArrangeCore(mode, auto); }
    catch (Exception ex) {
      Exception e = ex; while (e.InnerException != null) e = e.InnerException;
      throw new Exception("[" + step + "] " + e.GetType().Name + ": " + e.Message);
    }
  }

  static string ArrangeCore(string mode, int auto) {
    step = "ShellWindows";
    Type t = Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39"));
    IShellWindowsX windows = (IShellWindowsX)Activator.CreateInstance(t);
    object loc = 0;          // CSIDL_DESKTOP
    object root = null;      // VT_EMPTY
    int hwnd;
    step = "FindWindowSW";
    object disp = windows.FindWindowSW(ref loc, ref root, SWC_DESKTOP, out hwnd, SWFO_NEEDDISPATCH);
    if (disp == null) throw new Exception("Masaüstü penceresi bulunamadı");

    Guid sidTop = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
    Guid iidBrowser = new Guid("000214E2-0000-0000-C000-000000000046");
    step = "QueryService";
    object browserObj;
    Check(((IOleServiceProviderX)disp).QueryService(ref sidTop, ref iidBrowser, out browserObj), "QueryService");
    step = "QueryActiveShellView";
    object viewObj;
    Check(((IShellBrowserX)browserObj).QueryActiveShellView(out viewObj), "QueryActiveShellView");
    step = "IFolderView2";
    IFolderView2X view = (IFolderView2X)viewObj;

    Guid fmt = new Guid("B725F130-47EF-101A-A5F1-02608C9EEBAC");
    uint pid = 10;                                  // Ad
    if (mode == "type") pid = 4;                    // Öğe türü
    else if (mode == "date") pid = 14;              // Değiştirme tarihi
    else if (mode == "added") pid = 15;             // Oluşturulma tarihi (masaüstüne indirildiği/kopyalandığı an)
    else if (mode == "size") pid = 12;              // Boyut

    // Hizalama açık olsun; otomatik düzenleme kullanıcının seçimine göre
    uint mask = FWF_SNAPTOGRID;
    uint flags = FWF_SNAPTOGRID;
    if (auto >= 0) { mask |= FWF_AUTOARRANGE; if (auto == 1) flags |= FWF_AUTOARRANGE; }
    step = "SetCurrentFolderFlags";
    Check(view.SetCurrentFolderFlags(mask, flags), "SetCurrentFolderFlags");

    step = "SetSortColumns";
    SORTCOLUMN[] cols = new SORTCOLUMN[1];
    cols[0].propkey.fmtid = fmt;
    cols[0].propkey.pid = pid;
    cols[0].direction = (mode == "date" || mode == "added" || mode == "size") ? -1 : 1; // yeniler / büyükler önce
    Check(view.SetSortColumns(cols, 1), "SetSortColumns");
    return "ok";
  }
}
`;

const MODES = new Set(['name', 'type', 'date', 'added', 'size']);

/**
 * mode: 'name' | 'type' | 'date' | 'added' | 'size'
 * auto: -1 dokunma, 0 kapat, 1 aç (Otomatik düzenle)
 */
function arrangeDesktop(mode = 'type', auto = -1) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Bu özellik sadece Windows\'ta çalışır.' });
    if (!MODES.has(mode)) mode = 'type';
    auto = auto === 1 ? 1 : auto === 0 ? 0 : -1;

    const ps = [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'try {',
      "Add-Type -Language CSharp -TypeDefinition @'",
      CSHARP,
      "'@",
      `  [DesktopArranger]::Arrange('${mode}', ${auto}) | Out-Null`,
      '  Write-Output "OK"',
      '} catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; [Console]::Error.WriteLine("HATA: " + $e.Message); exit 1 }',
    ].join('\r\n');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');

    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
      { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'Zaman aşımı' }); }, 30000);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.includes('OK')) resolve({ ok: true });
      else {
        const text = (err || out || 'Bilinmeyen hata').trim();
        const line = text.split(/\r?\n/).find(l => l.startsWith('HATA:'));
        resolve({ ok: false, error: (line || text.split(/\r?\n/)[0]).replace(/^HATA:\s*/, '').slice(0, 400) });
      }
    });
  });
}

// Explorer'a "bu klasörler değişti, yeniden çiz" der (SHChangeNotify).
// OneDrive'a bağlı masaüstünde taşınan dosyaların simgesi bazen ekranda kalıyor; bu onu giderir.
const REFRESH_CS = String.raw`
using System;
using System.Runtime.InteropServices;
public static class ShellRefresh {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, IntPtr dwItem2);
  const int SHCNE_UPDATEDIR = 0x00001000;
  const int SHCNE_ASSOCCHANGED = 0x08000000;
  const uint SHCNF_PATHW = 0x0005;
  const uint SHCNF_FLUSHNOWAIT = 0x3000;
  public static void Refresh(string[] dirs) {
    foreach (string d in dirs) SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, d, IntPtr.Zero);
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSHNOWAIT, null, IntPtr.Zero);
  }
}
`;

let refreshTimer = null;
let pendingDirs = new Set();

// Birkaç taşıma art arda gelirse tek seferde yeniler
function refreshShell(dirs) {
  if (process.platform !== 'win32') return;
  (dirs || []).filter(Boolean).forEach(d => pendingDirs.add(d));
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const list = [...pendingDirs];
    pendingDirs = new Set();
    const arr = list.map(d => "'" + d.replace(/'/g, "''") + "'").join(',');
    const ps = [
      "Add-Type -Language CSharp -TypeDefinition @'", REFRESH_CS, "'@",
      `[ShellRefresh]::Refresh([string[]]@(${arr}))`,
    ].join('\r\n');
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
  }, 400);
}

module.exports = { arrangeDesktop, refreshShell, CSHARP };
