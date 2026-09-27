# Captura a janela do VS Code de teste (título com "loja-app") sem precisar trazê-la para frente.
param([string]$Marker, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  public struct RECT { public int L, T, R, B; }
}
"@
for ($i = 0; $i -lt 240 -and -not (Test-Path $Marker); $i++) { Start-Sleep -Milliseconds 500 }
$p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*loja-app*' } | Select-Object -First 1
if (-not $p) { Write-Error 'janela não encontrada'; exit 1 }
$h = $p.MainWindowHandle
[W]::ShowWindow($h, 1) | Out-Null
[W]::MoveWindow($h, 0, 0, 1600, 1000, $true) | Out-Null
Start-Sleep -Seconds 3
$r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
[W]::PrintWindow($h, $dc, 2) | Out-Null
$g.ReleaseHdc($dc); $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); "salvo $Out $($bmp.Width)x$($bmp.Height)"
