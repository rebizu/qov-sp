using System.Net.WebSockets;
using System.Text.Json;
using QovLibrary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace QovGuiNew;

public class PlayerService
{
    private string? _currentFile;
    private QovDecoder? _decoder;
    private FileStream? _fs;
    private QovHeader _header;

    public void LoadFile(string path)
    {
        _currentFile = path;
        // Clean up
        _fs?.Dispose();

        try
        {
            _fs = File.OpenRead(path);
            _decoder = new QovDecoder(_fs);
            _header = _decoder.DecodeHeader();
            Console.WriteLine($"Loaded: {path} ({_header.Width}x{_header.Height})");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Load Error: {ex.Message}");
        }
    }

    public async Task HandleConnection(WebSocket ws)
    {
        Console.WriteLine("Player Connected");
        
        if (_decoder == null) {
            await ws.CloseAsync(WebSocketCloseStatus.InternalServerError, "No file loaded", CancellationToken.None);
            return;
        }

        // Send Metadata
        var meta = new { width = _header.Width, height = _header.Height, fps = _header.FrameRateNum };
        string json = JsonSerializer.Serialize(meta);
        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);

        var buffer = new byte[1024];
        bool isPlaying = false;
        
        // Decoding loop task
        var sendTask = Task.Run(async () =>
        {
            // We need to re-create decoder to stream from start or seek
            // For now, let's just stream what we have.
            // DecodeFrames() is IEnumerable.
            
            try
            {
                foreach (var frame in _decoder.DecodeFrames())
                {
                    if (ws.State != WebSocketState.Open) break;

                    // Implement simple pause loop
                    while (!isPlaying && ws.State == WebSocketState.Open)
                    {
                        await Task.Delay(100);
                    }
                    if (ws.State != WebSocketState.Open) break;

                    // Send frame pixels
                    // Frame.Pixels is byte[] (RGBA)
                    await ws.SendAsync(new ArraySegment<byte>(frame.Pixels), WebSocketMessageType.Binary, true, CancellationToken.None);
                    
                    // Throttle
                    int delay = 1000 / (_header.FrameRateNum > 0 ? _header.FrameRateNum : 30);
                    await Task.Delay(delay);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Stream Loop Error: " + ex.Message);
            }
        });

        // Control loop
        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) break;

            string msg = System.Text.Encoding.UTF8.GetString(buffer, 0, result.Count);
            if (msg == "play") isPlaying = true;
            if (msg == "pause") isPlaying = false;
        }
        
    }
}
