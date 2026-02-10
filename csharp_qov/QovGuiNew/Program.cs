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
            .SetSize(1280, 820)
            .Center()
            .RegisterWebMessageReceivedHandler((object sender, string message) => {
                var window = (PhotinoWindow)sender;

                if (message == "devtools")
                {
                   try { 
                       Process.Start(new ProcessStartInfo("http://localhost:8000") { UseShellExecute = true });
                   } catch {}
                }
                else if (message.StartsWith("opened:"))
                {
                    // Acknowledgement
                }
                else if (message == "openFile")
                {
                    // Player Open
                    var path = OpenFileDialog("QOV Files (*.qov)|*.qov");
                    if (!string.IsNullOrEmpty(path))
                    {
                        window.SendWebMessage($"opened:{path.Replace("\\", "\\\\")}");
                        server.PlayerService.LoadFile(path);
                    }
                }
                else if (message == "saveFile")
                {
                    // Recorder Save
                     var path = SaveFileDialog("QOV Files (*.qov)|*.qov");
                     if (!string.IsNullOrEmpty(path))
                     {
                         // Notify Recorder Service via WebSocket or some shared state?
                         // Better: Send back to UI, UI sends to WebSocket.
                         window.SendWebMessage($"savedFile:{path.Replace("\\", "\\\\")}");
                     }
                }
                else if (message == "selectInput")
                {
                    // Converter Input
                     var path = OpenFileDialog("Video Files|*.mp4;*.webm;*.mkv;*.avi;*.mov;*.mpg;*.mpeg;*.ts");
                     if (!string.IsNullOrEmpty(path))
                     {
                         // Send to Converter Service? Or return to UI?
                         // UI needs to show it. ConverterService needs to know it?
                         // UI drives the conversion in our hybrid plan.
                         // So we return it to UI.
                         // But we also need to tell ConverterService? 
                         // Actually, in the new plan, UI loads video. 
                         // Check if UI can load local file path.
                         window.SendWebMessage($"inputSelected:{path.Replace("\\", "\\\\")}");
                     }
                }
                else if (message == "selectOutput")
                {
                    // Converter Output
                     var path = SaveFileDialog("QOV Files (*.qov)|*.qov");
                     if (!string.IsNullOrEmpty(path))
                     {
                         window.SendWebMessage($"outputSelected:{path.Replace("\\", "\\\\")}");
                     }
                }
            })
            .Load(Path.Combine(wwwroot, "index.html"));

        window.WaitForClose();
        server.Stop();
    }

    static string? OpenFileDialog(string filter)
    {
        try
        {
            var ps = new ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = $"-Command \"Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = '{filter}'; if ($f.ShowDialog() -eq 'OK') {{ $f.FileName }}\"",
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

    static string? SaveFileDialog(string filter)
    {
        try
        {
            var ps = new ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = $"-Command \"Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.SaveFileDialog; $f.Filter = '{filter}'; if ($f.ShowDialog() -eq 'OK') {{ $f.FileName }}\"",
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
