param(
    [int]$TargetPid = 18344,
    [string]$Out = "C:\_mycode\qiv\qov-thumbnail-provider\explorer.png"
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    public struct RECT { public int L, T, R, B; }
}
"@
$proc = Get-Process -Id $TargetPid
$hwnd = $proc.MainWindowHandle
$r = New-Object Cap+RECT
[Cap]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.R - $r.L
$h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Cap]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out)
Write-Output "saved $w x $h"
