using System.Net.WebSockets;
using System.Text; // For Encoding
using System.Text.Json; // For JSON
using QovLibrary;

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
        bool started = false;

        // Buffer for incoming chunks
        var receiveBuffer = new byte[1024 * 64];
        var textBuffer = new MemoryStream();
        // Buffer to accumulate a full frame; initialized once dimensions are known
        byte[]? frameBuffer = null;
        int frameBufferOffset = 0;
        bool discarding = false;

        long startTime = 0;

        Console.WriteLine("Recorder Connected");

        // Default file
        string filename = $"recording_{DateTime.Now:yyyyMMdd_HHmmss}.qov";

        async Task FinalizeAsync()
        {
            if (encoder != null)
            {
                try
                {
                    encoder.Finish();
                }
                catch (Exception ex)
                {
                    Console.WriteLine("Error finishing encoder: " + ex.Message);
                }
                encoder = null;
            }
            fs?.Close();
            fs = null;
            Console.WriteLine($"Recording Saved: {filename} ({currentFrameIndex} frames)");
            await SendJson(ws, new { type = "saved", path = filename, frames = currentFrameIndex });
        }

        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(receiveBuffer), CancellationToken.None);

                if (result.MessageType == WebSocketMessageType.Close) break;

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    textBuffer.Write(receiveBuffer, 0, result.Count);
                    if (!result.EndOfMessage) continue;
                    string json = Encoding.UTF8.GetString(textBuffer.ToArray());
                    textBuffer.SetLength(0);

                    try
                    {
                        var cmd = JsonSerializer.Deserialize<RecorderCommand>(json);
                        if (cmd == null) continue;

                        if (cmd.type == "start" && encoder == null)
                        {
                            width = cmd.width;
                            height = cmd.height;
                            fps = cmd.fps;
                            keyframePeriod = cmd.keyframePeriod > 0 ? cmd.keyframePeriod : 30;

                            if (!string.IsNullOrEmpty(cmd.path))
                            {
                                if (!PathGrants.IsGranted(cmd.path))
                                {
                                    Console.WriteLine($"Rejected ungranted output path: {cmd.path}");
                                    await SendJson(ws, new { type = "error", message = "Output path was not selected via the file dialog" });
                                    continue;
                                }
                                filename = cmd.path;
                            }

                            fs = new FileStream(filename, FileMode.Create);

                            // Map generic colorspace int to byte
                            byte cs = (byte)cmd.colorspace;
                            int qual = cmd.quality;
                            byte flags = QovTypes.FlagHasIndex; // Default flags

                            encoder = new QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps,
                                flags: flags, colorspace: cs, quality: qual);

                            Console.WriteLine($"Recording started: {width}x{height} @ {fps}fps, GOP={keyframePeriod}, CS={cs}, Q={qual} -> {filename}");
                            started = true;
                            startTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                            int frameSize = width * height * 4;
                            frameBuffer = new byte[frameSize];
                            frameBufferOffset = 0;
                            currentFrameIndex = 0;
                        }
                        else if (cmd.type == "stop" && started)
                        {
                            started = false;
                            await FinalizeAsync();
                        }
                    }
                    catch (Exception e)
                    {
                        Console.WriteLine("Command Error: " + e.Message);
                    }
                }
                else if (encoder != null && frameBuffer != null)
                {
                    // Binary data (raw RGBA), possibly split across fragments
                    if (discarding)
                    {
                        if (result.EndOfMessage)
                        {
                            discarding = false;
                            frameBufferOffset = 0;
                        }
                        continue;
                    }

                    if (frameBufferOffset + result.Count > frameBuffer.Length)
                    {
                        Console.WriteLine("Frame larger than expected; discarding until message boundary");
                        discarding = true;
                        if (result.EndOfMessage)
                        {
                            discarding = false;
                        }
                        frameBufferOffset = 0;
                        continue;
                    }

                    Array.Copy(receiveBuffer, 0, frameBuffer, frameBufferOffset, result.Count);
                    frameBufferOffset += result.Count;

                    if (result.EndOfMessage)
                    {
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
                        else
                        {
                            Console.WriteLine($"Short frame received ({frameBufferOffset}/{frameBuffer.Length} bytes); dropped");
                        }

                        frameBufferOffset = 0;
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
            // Client disconnected mid-recording: flush what we have
            if (encoder != null || fs != null)
            {
                if (encoder != null)
                {
                    try { encoder.Finish(); }
                    catch (Exception ex) { Console.WriteLine("Error finishing encoder: " + ex.Message); }
                    encoder = null;
                }
                fs?.Close();
                fs = null;
                Console.WriteLine("Recording Saved (on disconnect): " + filename);
            }
        }
    }

    private static async Task SendJson(WebSocket ws, object payload)
    {
        if (ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
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
