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
                     var meta = JsonSerializer.Deserialize<ConverterMeta>(json);
                     if (meta != null)
                     {
                         width = meta.width;
                         height = meta.height;
                         fps = meta.fps;
                         
                         fs = new FileStream(meta.filename, FileMode.Create);
                         encoder = new QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);
                         
                         startTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                         frameIndex = 0;
                         Console.WriteLine($"Converting to: {meta.filename}");
                     }
                }
                else if (result.MessageType == WebSocketMessageType.Binary && encoder != null)
                {
                    int expectedBytes = width * height * 4;
                    if (result.Count >= expectedBytes) 
                    {
                        // Direct byte array usage
                        // We received raw RGBA bytes, so we can pass them directly if Span supported
                        // QovEncoder accepts ReadOnlySpan<byte>
                        
                        // Timestamp: strictly based on FPS for converter
                        uint timestamp = (uint)(frameIndex * 1000.0 / fps);
                        
                        encoder.EncodePFrame(new ReadOnlySpan<byte>(buffer, 0, expectedBytes), timestamp);
                        frameIndex++;
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

    class ConverterMeta { 
        public string filename { get; set; } = "output.qov";
        public int width { get; set; } 
        public int height { get; set; } 
        public int fps { get; set; } 
    }
}
