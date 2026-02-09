using System.Net.WebSockets;
using System.Text; // For Encoding
using System.Text.Json; // For JSON
using QovLibrary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace QovGuiNew;

public class RecorderService
{
    public async Task HandleConnection(WebSocket ws)
    {
        QovEncoder? encoder = null;
        FileStream? fs = null;
        int width = 0, height = 0, fps = 30;
        
        var buffer = new byte[1024 * 1024 * 4]; // 4MB buffer
        bool headerReceived = false;
        long startTime = 0;

        Console.WriteLine("Recorder Connected");

        // Temporary file
        string filename = $"recording_{DateTime.Now:yyyyMMdd_HHmmss}.qov";
        
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);

                if (result.MessageType == WebSocketMessageType.Close) break;

                if (!headerReceived)
                {
                    // Expect JSON header
                    string json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    try {
                        var meta = JsonSerializer.Deserialize<VideoMeta>(json);
                        if (meta != null)
                        {
                            width = meta.width;
                            height = meta.height;
                            fps = meta.fps;
                            
                            fs = new FileStream(filename, FileMode.Create);
                            
                            // Initialize QovEncoder
                            // (Stream output, ushort width, ushort height, ushort frameRateNum = 30, ...)
                            encoder = new QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);
                            
                            Console.WriteLine($"Recording started: {width}x{height} @ {fps}fps -> {filename}");
                            headerReceived = true;
                            startTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        }
                    } catch (Exception e) {
                        Console.WriteLine("Header Error: " + e.Message);
                    }
                }
                else
                {
                    // Expect JPEG/Blob data
                    // Decode JPEG to Bitmap
                     if (result.Count > 0 && encoder != null)
                     {
                        using (var ms = new MemoryStream(buffer, 0, result.Count))
                        try 
                        {
                            using (var bitmap = new Bitmap(ms))
                            {
                                // Encode frame
                                BitmapData? bmpData = null;
                                try
                                {
                                    bmpData = bitmap.LockBits(
                                        new Rectangle(0, 0, bitmap.Width, bitmap.Height), 
                                        ImageLockMode.ReadOnly, 
                                        PixelFormat.Format32bppArgb);

                                    int numBytes = bitmap.Width * bitmap.Height * 4;
                                    byte[] pixels = new byte[numBytes];
                                    Marshal.Copy(bmpData.Scan0, pixels, 0, numBytes);

                                    // Calculate timestamp (ms)
                                    uint timestamp = (uint)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startTime);
                                    
                                    // Use P-frame by default, encoder handles first frame logic usually or we can force keyframe if needed.
                                    encoder.EncodePFrame(pixels.AsSpan(), timestamp);
                                }
                                finally
                                {
                                    if (bmpData != null) bitmap.UnlockBits(bmpData);
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                             Console.WriteLine($"Frame decode error: {ex.Message}");
                        }
                     }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Recorder Error: " + ex.Message);
        }
        finally
        {
            if (encoder != null)
            {
                // QovEncoder doesn't implement IDisposable but has Finish
                // Reflection or check source... Source calls Finish.
                // But wait, I added Finish() in Step 230 snippet? 
                // Line 1131 QovEncoder.Finish.
                // It is public? Yes.
                encoder.Finish();
            }
            fs?.Close();
            Console.WriteLine("Recording Saved: " + filename);
        }
    }

    class VideoMeta { public int width { get; set; } public int height { get; set; } public int fps { get; set; } }
}
