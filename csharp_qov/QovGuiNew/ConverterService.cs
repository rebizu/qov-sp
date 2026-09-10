using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using QovLibrary;

namespace QovGuiNew;

public class ConverterService
{
    public async Task HandleConnection(WebSocket ws)
    {
        QovEncoder? encoder = null;
        FileStream? fs = null;
        int width = 0, height = 0, fps = 30;

        var receiveBuffer = new byte[1024 * 64];
        var textBuffer = new MemoryStream();
        byte[]? frameBuffer = null;
        int frameBufferOffset = 0;
        bool discarding = false;

        int frameIndex = 0;
        string outputPath = "";

        Console.WriteLine("Converter Connected");

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
                        var cmd = JsonSerializer.Deserialize<ConverterCommand>(json);
                        if (cmd == null) continue;

                        if (cmd.type == "start" && encoder == null)
                        {
                            if (string.IsNullOrEmpty(cmd.path))
                            {
                                await SendJson(ws, new { type = "error", message = "No output path provided" });
                                continue;
                            }
                            if (!PathGrants.IsGranted(cmd.path))
                            {
                                Console.WriteLine($"Rejected ungranted output path: {cmd.path}");
                                await SendJson(ws, new { type = "error", message = "Output path was not selected via the file dialog" });
                                continue;
                            }

                            width = cmd.width;
                            height = cmd.height;
                            fps = cmd.fps > 0 ? cmd.fps : 30;
                            outputPath = cmd.path;

                            fs = new FileStream(outputPath, FileMode.Create);
                            encoder = new QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);

                            // Sized to the actual frame; buffers beyond 1920x1080
                            // must not silently fail
                            frameBuffer = new byte[width * height * 4];
                            frameBufferOffset = 0;
                            discarding = false;
                            frameIndex = 0;
                            Console.WriteLine($"Converting to: {outputPath} ({width}x{height} @ {fps}fps)");
                        }
                        else if (cmd.type == "finish" && encoder != null)
                        {
                            encoder.Finish();
                            encoder = null;
                            fs?.Close();
                            fs = null;
                            Console.WriteLine("Conversion finished.");
                            await SendJson(ws, new { type = "saved", path = outputPath, frames = frameIndex });
                        }
                    }
                    catch (Exception e)
                    {
                        Console.WriteLine("Command Error: " + e.Message);
                    }
                }
                else if (encoder != null && frameBuffer != null)
                {
                    // Binary frame data, possibly split across fragments
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
                                uint timestamp = (uint)(frameIndex * 1000.0 / fps);
                                encoder.EncodePFrame(new ReadOnlySpan<byte>(frameBuffer), timestamp);
                                frameIndex++;
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
            Console.WriteLine("Converter Error: " + ex.Message);
        }
        finally
        {
            if (encoder != null)
            {
                encoder.Finish();
                encoder = null;
            }
            fs?.Close();
        }
    }

    private static async Task SendJson(WebSocket ws, object payload)
    {
        if (ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    class ConverterCommand
    {
        public string type { get; set; } = "start";
        public string? path { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public int fps { get; set; }
    }
}
