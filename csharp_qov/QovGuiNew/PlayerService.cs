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
    private List<KeyframeInfo> _keyframes = new();
    private bool _isPlaying = false;

    private struct KeyframeInfo
    {
        public long Offset;
        public uint Timestamp;
        public int FrameNumber;
    }

    public async Task LoadFile(string path)
    {
        // Stop any existing playback
        _cts?.Cancel();
        if (_playbackTask != null)
        {
            try { await _playbackTask; } catch {}
        }
        
        _currentFile = path;
        
        // Clean up
        _fs?.Dispose();

        try
        {
            _fs = File.OpenRead(path);
            _fileSize = _fs.Length;
            _decoder = new QovDecoder(_fs);
            _header = _decoder.DecodeHeader();
            
            // Scan for keyframes
            _keyframes.Clear();
            int frameCount = 0;
            Console.WriteLine("Scanning for keyframes...");
            
            // Run scan on background thread to avoid blocking UI if called from there
            await Task.Run(() => {
                lock (_decoder)
                {
                    foreach (var chunk in _decoder.Scan())
                    {
                        if (chunk.ChunkType == QovTypes.ChunkTypeKeyframe)
                        {
                            _keyframes.Add(new KeyframeInfo { Offset = chunk.FileOffset, Timestamp = chunk.Timestamp, FrameNumber = frameCount });
                        }
                        
                        if (chunk.ChunkType == QovTypes.ChunkTypeKeyframe || chunk.ChunkType == QovTypes.ChunkTypePframe)
                        {
                            frameCount++;
                        }
                    }
                }
            });
            
            Console.WriteLine($"Loaded: {path} ({_header.Width}x{_header.Height}), found {_keyframes.Count} keyframes.");
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
                
                if (msg.StartsWith("{"))
                {
                    try {
                        using var doc = JsonDocument.Parse(msg);
                        var root = doc.RootElement;
                        if (root.TryGetProperty("type", out var typeProp))
                        {
                            string type = typeProp.GetString();
                            if (type == "openFile") 
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
                            else if (type == "seek") 
                            {
                                if (root.TryGetProperty("frame", out var frameProp))
                                {
                                    int targetFrame = frameProp.GetInt32();
                                    await PerformSeek(targetFrame, ws);
                                }
                            }
                        }
                    } catch (Exception ex) {
                        Console.WriteLine($"JSON Error: {ex.Message}");
                    }
                }
                else if (msg == "play") 
                {
                    _isPlaying = true;
                    _cts?.Cancel();
                    _cts = new CancellationTokenSource();
                    _playbackTask = StartStreamLoop(ws, _cts.Token);
                }
                else if (msg == "pause") 
                {
                    _isPlaying = false;
                    _cts?.Cancel();
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Player Socket Error: " + ex.Message);
        }
    }

    private async Task PerformSeek(int targetFrame, WebSocket ws)
    {
        // Cancel current playback
        _cts?.Cancel();
        
        if (_playbackTask != null)
        {
            try { await _playbackTask; } catch {}
        }
        
        // Find closest keyframe before targetFrame
        var keyframe = _keyframes.Where(k => k.FrameNumber <= targetFrame)
                                 .OrderByDescending(k => k.FrameNumber)
                                 .FirstOrDefault();
        
        if (keyframe.Offset == 0 && keyframe.FrameNumber != 0 && _keyframes.Count > 0)
        {
             // Fallback if not found (shouldn't happen if list populated)
             keyframe = _keyframes[0];
        }

        Console.WriteLine($"Seeking to frame {targetFrame}, using keyframe at {keyframe.FrameNumber} (offset {keyframe.Offset})");

        // Seek decoder
        lock (_decoder) // Ensure thread safety if needed
        {
            _decoder?.Seek(keyframe.Offset, (uint)keyframe.FrameNumber);
        }

        // If we were playing, restart loop. If paused, send one frame?
        // For simplicity, let's just restart loop if we want to play, 
        // OR just decode until we hit the target frame and stop if paused.
        
        _cts = new CancellationTokenSource();
        _playbackTask = StartStreamLoop(ws, _cts.Token, targetFrame);
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
    private Task? _playbackTask;
    
    public async Task StartStreamLoop(WebSocket ws, CancellationToken token, int targetFrame = -1)
    {
        await Task.Run(async () => {
             try
            {
                IEnumerable<QovLibrary.QovDecoder.QovDecodedChunk> enumerable;
                lock (_decoder)
                {
                    if (_decoder == null) return;
                    enumerable = _decoder.DecodeAll();
                }

                using var enumerator = enumerable.GetEnumerator();
                
                int targetFps = _header.FrameRateNum > 0 ? _header.FrameRateNum : 30;
                double targetIntervalMs = 1000.0 / targetFps;
                var stopwatch = new System.Diagnostics.Stopwatch();

                while (true)
                {
                    stopwatch.Restart();

                    if (ws.State != WebSocketState.Open || token.IsCancellationRequested) break;

                    QovLibrary.QovDecoder.QovDecodedChunk? chunk = null;
                    bool hasMore = false;
                    
                    try 
                    {
                        lock (_decoder)
                        {
                            // Check token again inside lock before doing work
                            if (token.IsCancellationRequested) break;
                            hasMore = enumerator.MoveNext();
                            if (hasMore) chunk = enumerator.Current;
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"Decode Error: {ex.Message}");
                        break;
                    }
                    
                    if (!hasMore || chunk == null) break;
                    
                    // Send Chunk Metadata (for Timeline) - Always send metadata so timeline updates?
                    // Maybe only send if we are close or if it's keyframes?
                    // To keep UI responsive during seek, maybe skip sending chunk meta if skipping frames?
                    bool isSkipping = targetFrame != -1 && (chunk.Payload is QovFrame fCheck && fCheck.FrameNumber < targetFrame);
                    
                    if (!isSkipping)
                    {
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
                    }

                    if (chunk.Payload is QovFrame frame)
                    {
                        if (targetFrame != -1)
                        {
                             if (frame.FrameNumber < targetFrame)
                             {
                                 continue;
                             }
                             
                             // Reached target
                             targetFrame = -1;
                             
                             // If paused, send this frame and stop
                             if (!_isPlaying)
                             {
                                 await SendFrameData(ws, frame, token);
                                 break;
                             }
                        }

                        await SendFrameData(ws, frame, token);
                         
                        double elapsed = stopwatch.Elapsed.TotalMilliseconds;
                        int waitTime = (int)(targetIntervalMs - elapsed);
                        if (waitTime > 0)
                        {
                            await Task.Delay(waitTime, token);
                        }
                    }
                    else if (chunk.Payload is QovAudioFrame audio)
                    {
                        // Handle audio
                    }
                }
                
                if (!token.IsCancellationRequested && ws.State == WebSocketState.Open && _isPlaying)
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

    private async Task SendFrameData(WebSocket ws, QovFrame frame, CancellationToken token)
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
        await ws.SendAsync(new ArraySegment<byte>(metaBytes), WebSocketMessageType.Text, true, token);

        // Send frame data
        await ws.SendAsync(new ArraySegment<byte>(frame.Pixels), WebSocketMessageType.Binary, true, token);
    }
}
