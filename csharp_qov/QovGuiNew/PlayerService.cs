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

    private long _fileSize;

    public void LoadFile(string path)
    {
        // Stop any existing playback
        _cts?.Cancel();
        
        _currentFile = path;
        
        // Clean up
        _fs?.Dispose();

        try
        {
            _fs = File.OpenRead(path);
            _fileSize = _fs.Length;
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
        
        // Control loop
        try 
        {
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close) break;

                string msg = System.Text.Encoding.UTF8.GetString(buffer, 0, result.Count);
                
                if (msg.Contains("openFile")) 
                {
                     if (_header.Width > 0)
                     {
                        var meta = new { 
                            type = "meta", 
                            width = _header.Width, 
                            height = _header.Height, 
                            fps = _header.FrameRateNum, 
                            totalFrames = _header.TotalFrames,
                            version = _header.Version,
                            colorspace = _header.Colorspace.ToString(),
                            flags = GetFlagNames(_header.Flags),
                            fileSize = _fileSize
                        }; 
                        string json = JsonSerializer.Serialize(meta);
                        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
                        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
                     }
                }
                else if (msg == "play") 
                {
                    _cts?.Cancel();
                    _cts = new CancellationTokenSource();
                    _ = StartStreamLoop(ws, _cts.Token);
                }
                else if (msg == "pause") 
                {
                    _cts?.Cancel();
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Player Socket Error: " + ex.Message);
        }
    }
    
    private string GetFlagNames(byte flags)
    {
        var names = new List<string>();
        if ((flags & QovTypes.FlagHasAlpha) != 0) names.Add("Alpha");
        if ((flags & QovTypes.FlagHasMotion) != 0) names.Add("Motion");
        if ((flags & QovTypes.FlagHasIndex) != 0) names.Add("Index");
        if ((flags & QovTypes.FlagHasBFrames) != 0) names.Add("B-Frames");
        if ((flags & QovTypes.FlagEnhancedComp) != 0) names.Add("Enhanced");
        if ((flags & QovTypes.FlagLossyMode) != 0) names.Add("Lossy");
        if ((flags & QovTypes.FlagDctEnabled) != 0) names.Add("DCT");
        
        return names.Count > 0 ? string.Join(", ", names) : "None";
    }
    
    private CancellationTokenSource? _cts;
    
    public async Task StartStreamLoop(WebSocket ws, CancellationToken token)
    {
        await Task.Run(async () => {
             try
            {
                if (_decoder == null) return;
                
                foreach (var chunk in _decoder.DecodeAll())
                {
                    if (ws.State != WebSocketState.Open || token.IsCancellationRequested) break;
                    
                    // Send Chunk Metadata (for Timeline)
                    var chunkMeta = new {
                        type = "chunk",
                        cType = chunk.ChunkType,
                        typeName = QovTypes.GetChunkTypeName(chunk.ChunkType),
                        size = chunk.ChunkSize,
                        offset = chunk.FileOffset,
                        ts = chunk.Timestamp
                    };
                    var chunkJson = JsonSerializer.Serialize(chunkMeta);
                    await ws.SendAsync(new ArraySegment<byte>(System.Text.Encoding.UTF8.GetBytes(chunkJson)), WebSocketMessageType.Text, true, CancellationToken.None);

                    if (chunk.Payload is QovFrame frame)
                    {
                        // Send Frame Metadata
                        var frameMeta = new {
                            type = "frame",
                            num = frame.FrameNumber,
                            ts = frame.Timestamp,
                            key = frame.IsKeyframe,
                            ftype = frame.IsKeyframe ? "Key" : "P-Frame" 
                        };
                        var metaJson = JsonSerializer.Serialize(frameMeta);
                        var metaBytes = System.Text.Encoding.UTF8.GetBytes(metaJson);
                        await ws.SendAsync(new ArraySegment<byte>(metaBytes), WebSocketMessageType.Text, true, CancellationToken.None);
    
                        // Send frame data
                         await ws.SendAsync(new ArraySegment<byte>(frame.Pixels), WebSocketMessageType.Binary, true, CancellationToken.None);
                         
                         int delay = 1000 / (_header.FrameRateNum > 0 ? _header.FrameRateNum : 30);
                         await Task.Delay(delay, token);
                    }
                    else if (chunk.Payload is QovAudioFrame audio)
                    {
                        // Handle audio if we were playing it? 
                        // For now just visualization in timeline is enough.
                    }
                }
                
                if (!token.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                     var eof = System.Text.Encoding.UTF8.GetBytes("{\"type\":\"eof\"}");
                     await ws.SendAsync(new ArraySegment<byte>(eof), WebSocketMessageType.Text, true, CancellationToken.None);
                }
            }
            catch (OperationCanceledException) 
            {
                // Normal pause
            }
            catch (Exception ex)
            {
                Console.WriteLine("Stream Loop Error: " + ex.Message);
            }
        }, token);
    }
}
