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
        
        var buffer = new byte[1024];
        bool isPlaying = false;
        
        // Control loop
        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) break;

            string msg = System.Text.Encoding.UTF8.GetString(buffer, 0, result.Count);
            
            if (msg.Contains("openFile")) // Simple command
            {
                 // Re-send metadata if file loaded
                 if (_decoder != null)
                 {
                    var meta = new { type = "meta", width = _header.Width, height = _header.Height, fps = _header.FrameRateNum, totalFrames = 0 }; // totalFrames depends on index
                    string json = JsonSerializer.Serialize(meta);
                    var bytes = System.Text.Encoding.UTF8.GetBytes(json);
                    await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
                 }
            }
            
            if (msg == "play" && _decoder != null) 
            {
                if (!isPlaying) {
                    isPlaying = true;
                    // Fire and forget the stream loop, it will be controlled by _cts
                    _ = StartStreamLoop(ws);
                }
            }
            if (msg == "pause") 
            {
                isPlaying = false;
                _cts?.Cancel();
            }
        }
    }
    
    // We need a separate specialized method to start the loop, or just run it in background when file loaded? 
    // The previous implementation had a Task.Run. Let's restore a better version of that.
    
    private CancellationTokenSource? _cts;
    
    public async Task StartStreamLoop(WebSocket ws)
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var token = _cts.Token;

        await Task.Run(async () => {
             try
            {
                if (_decoder == null) return;
                
                // Reset to beginning? Or current?
                // _decoder.Seek(0); 
                
                foreach (var frame in _decoder.DecodeFrames())
                {
                    if (ws.State != WebSocketState.Open || token.IsCancellationRequested) break;

                    // Pause check
                    // We need a way to check 'isPlaying' flag from the main loop. 
                    // Let's use a shared volatile bool or similar. 
                    // Actually, let's just loop.
                    
                    // Send frame
                     await ws.SendAsync(new ArraySegment<byte>(frame.Pixels), WebSocketMessageType.Binary, true, CancellationToken.None);
                     
                     int delay = 1000 / (_header.FrameRateNum > 0 ? _header.FrameRateNum : 30);
                     await Task.Delay(delay);
                }
                 // End of file
                 var eof = System.Text.Encoding.UTF8.GetBytes("{\"type\":\"eof\"}");
                 await ws.SendAsync(new ArraySegment<byte>(eof), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.WriteLine("Stream Loop Error: " + ex.Message);
            }
        });
    }
}
