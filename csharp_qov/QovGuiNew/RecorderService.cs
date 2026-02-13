using System.Net.WebSockets;
using System.Text; // For Encoding
using System.Text.Json; // For JSON
using QovLibrary;
using System.Runtime.InteropServices;

namespace QovGuiNew;

public class RecorderService
{
    public async Task HandleConnection(WebSocket ws)
    {
        QovEncoder? encoder = null;
        FileStream? fs = null;
        int width = 0, height = 0, fps = 30;
        int keyframePeriod = 30;
        int currentFrameIndex = 0;
        
        // Buffer for incoming chunks
        var receiveBuffer = new byte[1024 * 64]; 
        // Buffer to accumulate a full frame
        // We'll initialize it when we know the dimensions.
        byte[]? frameBuffer = null;
        int frameBufferOffset = 0;
        
        bool headerReceived = false;
        long startTime = 0;

        Console.WriteLine("Recorder Connected");

        // Temporary file
        string filename = $"recording_{DateTime.Now:yyyyMMdd_HHmmss}.qov";
        
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                // Receive a chunk
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(receiveBuffer), CancellationToken.None);

                if (result.MessageType == WebSocketMessageType.Close) break;

                if (!headerReceived)
                {
                    // Expect JSON header
                    string json = Encoding.UTF8.GetString(receiveBuffer, 0, result.Count);
                    try {
                        var cmd = JsonSerializer.Deserialize<RecorderCommand>(json);
                        if (cmd != null && cmd.type == "start")
                        {
                            width = cmd.width;
                            height = cmd.height;
                            fps = cmd.fps;
                            keyframePeriod = cmd.keyframePeriod > 0 ? cmd.keyframePeriod : 30;
                            
                            if (!string.IsNullOrEmpty(cmd.path))
                            {
                                filename = cmd.path;
                            }
                            
                            fs = new FileStream(filename, FileMode.Create);
                            
                            // Map generic colorspace int to byte
                            byte cs = (byte)cmd.colorspace;
                            int qual = cmd.quality;
                            byte flags = QovTypes.FlagHasIndex; // Default flags
                            
                            // Initialize QovEncoder
                            encoder = new QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps, 
                                flags: flags, colorspace: cs, quality: qual);
                            
                            Console.WriteLine($"Recording started: {width}x{height} @ {fps}fps, GOP={keyframePeriod}, CS={cs}, Q={qual} -> {filename}");
                            headerReceived = true;
                            startTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            
                            // Initialize frame buffer
                            int frameSize = width * height * 4;
                            frameBuffer = new byte[frameSize];
                            frameBufferOffset = 0;
                            currentFrameIndex = 0;
                        }
                    } catch (Exception e) {
                        Console.WriteLine("Header Error: " + e.Message);
                    }
                }
                else
                {
                    // Binary Data (Raw RGBA)
                    if (encoder != null && frameBuffer != null)
                    {
                        // Copy received chunk to frame buffer
                        if (frameBufferOffset + result.Count <= frameBuffer.Length)
                        {
                            Array.Copy(receiveBuffer, 0, frameBuffer, frameBufferOffset, result.Count);
                            frameBufferOffset += result.Count;
                        }
                        else
                        {
                             // Buffer overflow or sync error
                             frameBufferOffset = 0;
                        }

                        if (result.EndOfMessage)
                        {
                             // Process full frame
                             if (frameBufferOffset == frameBuffer.Length)
                             {
                                try
                                {
                                    // Calculate timestamp (ms)
                                    uint timestamp = (uint)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startTime);
                                    
                                    // Encode
                                    if (currentFrameIndex % keyframePeriod == 0)
                                    {
                                        encoder.EncodeKeyframe(frameBuffer.AsSpan(), timestamp);
                                        Console.Write("K"); // debug indicator
                                    }
                                    else
                                    {
                                        encoder.EncodePFrame(frameBuffer.AsSpan(), timestamp);
                                    }
                                    currentFrameIndex++;
                                }
                                catch (Exception ex)
                                {
                                     Console.WriteLine($"Frame encode error: {ex.Message}");
                                }
                             }
                             
                             // Reset for next frame
                             frameBufferOffset = 0;
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
                try {
                    encoder.Finish();
                } catch(Exception ex) {
                    Console.WriteLine("Error finishing encoder: " + ex.Message);
                }
            }
            fs?.Close();
            Console.WriteLine("Recording Saved: " + filename);
        }
    }

    class RecorderCommand 
    { 
        public string type { get; set; } = "start";
        public string? path { get; set; }
        public int width { get; set; } 
        public int height { get; set; } 
        public int fps { get; set; } 
        public int keyframePeriod { get; set; }
        public int colorspace { get; set; }
        public string encodingMode { get; set; } = "lossless";
        public int quality { get; set; }
    }
}
