using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using QovLibrary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace QovGuiNew;

public class ConverterService
{
    public async Task HandleConnection(WebSocket ws)
    {
        QovEncoder? encoder = null;
        FileStream? fs = null;
        int width = 0, height = 0, fps = 30;
        
        // Large buffer for RAW frames (RGBA 1920x1080x4 = ~8MB)
        var buffer = new byte[1920 * 1080 * 4 + 1024]; 
        long startTime = 0;
        int frameIndex = 0;
        
        Console.WriteLine("Converter Connected");

        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                
                if (result.MessageType == WebSocketMessageType.Close) break;

                if (result.MessageType == WebSocketMessageType.Text)
                {
                     string json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                     try {
                        var cmd = JsonSerializer.Deserialize<ConverterCommand>(json);
                        if (cmd != null)
                        {
                            if (cmd.type == "start")
                            {
                                 width = cmd.width;
                                 height = cmd.height;
                                 fps = cmd.fps;
                                 
                                 if (!string.IsNullOrEmpty(cmd.path))
                                 {
                                     fs = new FileStream(cmd.path, FileMode.Create);
                                     encoder = new QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);
                                     
                                     startTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                     frameIndex = 0;
                                     Console.WriteLine($"Converting to: {cmd.path}");
                                 }
                            }
                            else if (cmd.type == "finish")
                            {
                                if (encoder != null) 
                                {
                                    encoder.Finish();
                                    encoder = null;
                                }
                                fs?.Close();
                                fs = null;
                                Console.WriteLine("Conversion finished.");
                            }
                        }
                     } catch (Exception e) {
                         Console.WriteLine("Command Error: " + e.Message);
                     }
                }
                else if (result.MessageType == WebSocketMessageType.Binary && encoder != null)
                {
                    int expectedBytes = width * height * 4;
                    if (result.Count >= expectedBytes) 
                    {
                        uint timestamp = (uint)(frameIndex * 1000.0 / fps);
                        encoder.EncodePFrame(new ReadOnlySpan<byte>(buffer, 0, expectedBytes), timestamp);
                        frameIndex++;
                        
                        // Optional: Send progress back
                        if (frameIndex % 30 == 0) {
                             // await ws.SendAsync... 
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Converter Error: " + ex.Message);
        }
        finally
        {
            if (encoder != null) encoder.Finish();
            fs?.Close();
        }
    }

    class ConverterCommand { 
        public string type { get; set; } = "start";
        public string? path { get; set; }
        public int width { get; set; } 
        public int height { get; set; } 
        public int fps { get; set; } 
    }
}
