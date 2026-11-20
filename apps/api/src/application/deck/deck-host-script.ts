/**
 * ADR-0008 — the Deck container, as a PowerShell + WinForms host.
 *
 * Why a script and not Electron/koffi: the spike (2026-11-20) showed that
 * plain user32 calls are enough, and a script needs no native binary or new
 * dependency (the v0.13 AV kills made a helper .exe unattractive). It is
 * written to <dataDir>/deck-host.ps1 and driven over stdin/stdout, one JSON
 * object per line:
 *   in : adopt {id,pid,label} | label {id,label} | remove {id} | select {id} | quit
 *   out: ready | adopted {id,ok} | selected {id} | gone {id} | closed
 * Modes: "deck" (container window) and "group" (taskbar grouping only: sets
 * one AppUserModelID on every window of the given pids, prints JSON, exits).
 *
 * Fingerprint guard: an adopted window keeps WS_OVERLAPPEDWINDOW and only
 * swaps WS_POPUP for WS_CHILD. Stripping the frame changed outer-inner by
 * 2px/1px in the spike; keeping it leaves 16/95 identical to a free window.
 * The invisible resize border is offset outside the container, never hidden.
 *
 * The script is a plain string with no backticks or dollar-braces so it can
 * live in a template literal unescaped.
 */
export const DECK_HOST_SCRIPT = String.raw`param([string]$Mode = "deck", [string]$Pids = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PK { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPS {
    [PreserveSig] int GetCount(out uint c); [PreserveSig] int GetAt(uint i, out PK k);
    [PreserveSig] int GetValue(ref PK k, out PV v); [PreserveSig] int SetValue(ref PK k, ref PV v); [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid riid, out IPS ps);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  delegate bool EP(IntPtr h, IntPtr l);
  public static List<IntPtr> Find(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { var sb = new StringBuilder(64); GetClassName(h, sb, 64); if (sb.ToString() == "Chrome_WidgetWin_1") r.Add(h); }
      return true; }, IntPtr.Zero);
    return r;
  }
  public static long Area(IntPtr h) { R r; GetWindowRect(h, out r); return (long)(r.r - r.l) * (r.b - r.t); }
  static PK Key() { return new PK { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; }
  static IPS Store(IntPtr h, out int hr) { Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPS ps; hr = SHGetPropertyStoreForWindow(h, ref iid, out ps); return ps; }
  public static int SetAumid(IntPtr h, string id) {
    int hr; var ps = Store(h, out hr); if (hr != 0) return hr;
    var k = Key(); var v = new PV { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    hr = ps.SetValue(ref k, ref v); if (hr == 0) hr = ps.Commit();
    Marshal.FreeCoTaskMem(v.p); return hr;
  }
  public static string GetAumid(IntPtr h) {
    int hr; var ps = Store(h, out hr); if (hr != 0) return null;
    var k = Key(); PV v; if (ps.GetValue(ref k, out v) != 0 || v.vt != 31) return null;
    return Marshal.PtrToStringUni(v.p);
  }
}
"@
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
$GWL_STYLE = -16
$WS_POPUP = [int]::MinValue
$WS_CHILD = 0x40000000

if ($Mode -eq "group") {
  $out = @()
  foreach ($p in ($Pids -split ",")) { if ($p -match "^\d+$") {
    foreach ($h in [W]::Find([uint32]$p)) {
      $hr = [W]::SetAumid($h, "QueuePilot.Profiles")
      $out += @{ pid = [int]$p; hr = $hr; aumid = [W]::GetAumid($h) }
    } } }
  Emit @{ grouped = $out }
  exit 0
}

$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f = New-Object System.Windows.Forms.Form
$f.Text = "QueuePilot Deck"; $f.StartPosition = "Manual"
$f.Left = $work.Left + 20; $f.Top = $work.Top + 20
# Window-fit: an engine window may not exceed its profile's claimed screen (>= 1366x728 usable),
# so the container is capped well inside that and cannot be maximised.
$f.ClientSize = New-Object System.Drawing.Size([Math]::Min(1280, $work.Width - 60), [Math]::Min(714, $work.Height - 100))
$f.MaximumSize = $f.Size; $f.MaximizeBox = $false
$strip = New-Object System.Windows.Forms.FlowLayoutPanel
$strip.Dock = "Top"; $strip.Height = 34; $strip.WrapContents = $false; $strip.AutoScroll = $true
$strip.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 40)
$body = New-Object System.Windows.Forms.Panel; $body.Dock = "Fill"
$f.Controls.Add($body); $f.Controls.Add($strip)

$tabs = @{}
$pending = @()
$script:current = $null

function Fit($h) { [void][W]::MoveWindow($h, -8, 0, $body.ClientSize.Width + 16, $body.ClientSize.Height + 8, $true) }
function Select-Tab($id) {
  if (-not $tabs.ContainsKey($id)) { return }
  foreach ($k in @($tabs.Keys)) {
    $on = ($k -eq $id)
    [void][W]::ShowWindow($tabs[$k].h, $(if ($on) { 5 } else { 0 }))
    $tabs[$k].btn.BackColor = $(if ($on) { [System.Drawing.Color]::FromArgb(70, 90, 160) } else { [System.Drawing.Color]::FromArgb(50, 50, 62) })
  }
  Fit $tabs[$id].h
  $script:current = $id
  Emit @{ event = "selected"; id = $id }
}
function Release($t) {
  if (-not [W]::IsWindow($t.h)) { return }
  [void][W]::SetParent($t.h, [IntPtr]::Zero)
  [void][W]::SetWindowLong($t.h, $GWL_STYLE, $t.style)
  [void][W]::MoveWindow($t.h, $t.rect.l, $t.rect.t, $t.rect.r - $t.rect.l, $t.rect.b - $t.rect.t, $true)
  [void][W]::ShowWindow($t.h, 5)
}
function Drop-Tab($id, $release) {
  if (-not $tabs.ContainsKey($id)) { return }
  $t = $tabs[$id]
  if ($release) { Release $t }
  $strip.Controls.Remove($t.btn); $t.btn.Dispose(); $tabs.Remove($id)
  if ($script:current -eq $id) { $script:current = $null; $first = @($tabs.Keys) | Select-Object -First 1; if ($first) { Select-Tab $first } }
}
function Try-Adopt($m) {
  $ws = [W]::Find([uint32]$m.pid)
  if ($ws.Count -eq 0) { return $false }
  $h = ($ws | Sort-Object { -[W]::Area($_) })[0]
  $r = New-Object W+R
  [void][W]::GetWindowRect($h, [ref]$r)
  $style = [W]::GetWindowLong($h, $GWL_STYLE)
  [void][W]::SetParent($h, $body.Handle)
  [void][W]::SetWindowLong($h, $GWL_STYLE, (($style -band (-bnot $WS_POPUP)) -bor $WS_CHILD))
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $m.label; $btn.AutoSize = $true; $btn.FlatStyle = "Flat"; $btn.ForeColor = "White"
  $btn.Margin = New-Object System.Windows.Forms.Padding(2, 3, 0, 0)
  $btn.Tag = [string]$m.id
  $btn.Add_Click({ param($s, $e) Select-Tab $s.Tag })
  $strip.Controls.Add($btn)
  $tabs[[string]$m.id] = @{ h = $h; btn = $btn; style = $style; rect = $r }
  Select-Tab ([string]$m.id)
  return $true
}
$f.Add_Resize({ if ($script:current -and $tabs.ContainsKey($script:current)) { Fit $tabs[$script:current].h } })
$f.Add_FormClosing({ foreach ($t in @($tabs.Values)) { Release $t } })
$f.Show()
Emit @{ event = "ready" }

$rd = [Console]::In.ReadLineAsync()
$lastCheck = [DateTime]::UtcNow
while ($f.Visible) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 40
  if ($rd.IsCompleted) {
    $line = $rd.Result
    if ($null -eq $line) { $f.Close(); break }
    $rd = [Console]::In.ReadLineAsync()
    try { $m = $line | ConvertFrom-Json } catch { continue }
    switch ($m.cmd) {
      "adopt"  { $dup = $false; foreach ($q in $pending) { if ([string]$q.m.id -eq [string]$m.id) { $dup = $true } }
                if (-not $dup -and -not $tabs.ContainsKey([string]$m.id)) { $pending += @{ m = $m; until = [DateTime]::UtcNow.AddSeconds(30) } } }
      "label"  { if ($tabs.ContainsKey([string]$m.id)) { $tabs[[string]$m.id].btn.Text = $m.label } }
      "remove" { Drop-Tab ([string]$m.id) $true }
      "select" { Select-Tab ([string]$m.id) }
      "quit"   { $f.Close() }
    }
  }
  if ($pending.Count -gt 0) {
    $still = @()
    foreach ($p in $pending) {
      if ($tabs.ContainsKey([string]$p.m.id)) { continue }
      if (Try-Adopt $p.m) { Emit @{ event = "adopted"; id = [string]$p.m.id; ok = $true } }
      elseif ([DateTime]::UtcNow -gt $p.until) { Emit @{ event = "adopted"; id = [string]$p.m.id; ok = $false } }
      else { $still += $p }
    }
    $pending = $still
  }
  if (([DateTime]::UtcNow - $lastCheck).TotalSeconds -ge 1) {
    $lastCheck = [DateTime]::UtcNow
    foreach ($k in @($tabs.Keys)) { if (-not [W]::IsWindow($tabs[$k].h)) { Drop-Tab $k $false; Emit @{ event = "gone"; id = $k } } }
  }
}
Emit @{ event = "closed" }
`;
