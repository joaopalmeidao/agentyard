# Grava a janela do VS Code de teste quadro a quadro (PrintWindow) entre os marcadores start e stop.
param([string]$Dir)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  public struct RECT { public int L, T, R, B; }
}
"@
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 400 -and $h -eq [IntPtr]::Zero; $i++) {
  $p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*loja-app*' } | Select-Object -First 1
  if ($p) { $h = $p.MainWindowHandle } else { Start-Sleep -Milliseconds 300 }
}
if ($h -eq [IntPtr]::Zero) { Write-Error 'janela nao encontrada'; exit 1 }
[W]::MoveWindow($h, 0, 0, 1600, 1000, $true) | Out-Null
for ($i = 0; $i -lt 600 -and -not (Test-Path "$Dir\start"); $i++) { Start-Sleep -Milliseconds 200 }
New-Item -ItemType Directory -Force "$Dir\frames" | Out-Null
$start = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$n = 0
while (-not (Test-Path "$Dir\stop")) {
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [W]::PrintWindow($h, $dc, 2) | Out-Null
  $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save(("$Dir\frames\f{0:D5}.png" -f $n), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $n++
}
$end = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
[IO.File]::WriteAllText("$Dir\timing.json", "{`"start`":$start,`"end`":$end,`"frames`":$n}")
"gravados $n quadros em $(($end - $start) / 1000)s"
