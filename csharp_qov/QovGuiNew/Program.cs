using Photino.NET;
using System.Net;
using System.Net.WebSockets;
using System.Drawing;
using System.Text;
using System.Text.Json;
using QovLibrary;
using System.Diagnostics;

namespace QovGuiNew;

class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // Start WebSocket Server
        var server = new WebSocketServer("http://localhost:8000/");
        Task.Run(() => server.Start());

        // Create Photino Window
        string wwwroot = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot");
        
        if (!Directory.Exists(wwwroot))
        {
             wwwroot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"..\..\..\wwwroot"));
        }

        var window = new PhotinoWindow()
            .SetTitle("QOV GUI")
            .SetUseOsDefaultSize(false)
            .SetSize(1024, 768)
            .Center()
            .RegisterWebMessageReceivedHandler((object sender, string message) => {
                var window = (PhotinoWindow)sender;

                if (message == "devtools")
                {
                   // window.OpenExternalBrowser("http://localhost:8000"); // Not available in all versions
                   try { 
                       Process.Start(new ProcessStartInfo("http://localhost:8000") { UseShellExecute = true });
                   } catch {}
                }
                else if (message.StartsWith("opened:"))
                {
                    // This is echo back? No, checking logic.
                }
                else if (message == "openFile")
                {
                    var path = OpenFileDialog();
                    if (!string.IsNullOrEmpty(path))
                    {
                        window.SendWebMessage($"opened:{path.Replace("\\", "\\\\")}");
                        server.PlayerService.LoadFile(path);
                    }
                }
            })
            .Load(Path.Combine(wwwroot, "index.html"));

        window.WaitForClose();
        server.Stop();
    }

    static string? OpenFileDialog()
    {
        try
        {
            var ps = new ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = "-Command \"Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'QOV Files (*.qov)|*.qov|All Files (*.*)|*.*'; if ($f.ShowDialog() -eq 'OK') { $f.FileName }\"",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            var proc = Process.Start(ps);
            if (proc == null) return null;
            var path = proc.StandardOutput.ReadToEnd().Trim();
            proc.WaitForExit();
            return string.IsNullOrEmpty(path) ? null : path;
        }
        catch { return null; }
    }
}
