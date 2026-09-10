using System.Net.WebSockets;
using System.Text.Json;
using QovLibrary;

namespace QovGuiNew;

public class PlayerService
{
    // Guards decoder/file/keyframe state. Never lock the QovDecoder instance
    // itself: LoadFile swaps it, which silently breaks mutual exclusion.
    private readonly object _lock = new object();
    // Serializes file loads so two overlapping LoadFile calls cannot interleave
    private readonly SemaphoreSlim _loadLock = new SemaphoreSlim(1, 1);

    private QovDecoder? _decoder;
    private FileStream? _fs;
    private QovHeader _header;
    private long _fileSize;
    private List<KeyframeInfo> _keyframes = new();
    private bool _isPlaying = false;

    private CancellationTokenSource? _cts;
    private Task? _playbackTask;

    private struct KeyframeInfo
    {
        public long Offset;
        public uint Timestamp;
        public int FrameNumber;
    }

    public async Task LoadFile(string path)
    {
        await _loadLock.WaitAsync();
        try
        {
            await StopPlaybackAsync();

            // Swap out the old state under the lock, dispose outside it
            FileStream? oldFs;
            lock (_lock)
            {
                oldFs = _fs;
                _fs = null;
                _decoder = null;
                _keyframes = new List<KeyframeInfo>();
                _header = default;
                _fileSize = 0;
            }
            oldFs?.Dispose();

            try
            {
                var fs = File.OpenRead(path);
                var decoder = new QovDecoder(fs);
                var header = decoder.DecodeHeader();

                Console.WriteLine("Scanning for keyframes...");

                // Build the index in a local list and publish it atomically,
                // so seek never enumerates a half-populated list
                var keyframes = new List<KeyframeInfo>();
                int frameCount = 0;
                await Task.Run(() => {
                    foreach (var chunk in decoder.Scan())
                    {
                        if (chunk.ChunkType == QovTypes.ChunkTypeKeyframe)
                        {
                            keyframes.Add(new KeyframeInfo { Offset = chunk.FileOffset, Timestamp = chunk.Timestamp, FrameNumber = frameCount });
                        }

                        if (chunk.ChunkType == QovTypes.ChunkTypeKeyframe || chunk.ChunkType == QovTypes.ChunkTypePframe)
                        {
                            frameCount++;
                        }
                    }
                });

                lock (_lock)
                {
                    _fs = fs;
                    _decoder = decoder;
                    _header = header;
                    _fileSize = fs.Length;
                    _keyframes = keyframes;
                }

                Console.WriteLine($"Loaded: {path} ({header.Width}x{header.Height}), found {keyframes.Count} keyframes.");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Load Error: {ex.Message}");
            }
        }
        finally
        {
            _loadLock.Release();
        }
    }

    public async Task HandleConnection(WebSocket ws)
    {
        Console.WriteLine("Player Connected");

        var buffer = new byte[1024];
        var textBuffer = new System.IO.MemoryStream();

        // Control loop
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close) break;

                textBuffer.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;
                string msg = System.Text.Encoding.UTF8.GetString(textBuffer.ToArray());
                textBuffer.SetLength(0);

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
                                 QovHeader header;
                                 long fileSize;
                                 lock (_lock)
                                 {
                                     header = _header;
                                     fileSize = _fileSize;
                                 }
                                 if (header.Width > 0)
                                 {
                                    var meta = new {
                                        type = "meta",
                                        width = header.Width,
                                        height = header.Height,
                                        fps = header.FrameRateDen > 0 ? Math.Round((double)header.FrameRateNum / header.FrameRateDen, 3) : 30,
                                        totalFrames = header.TotalFrames,
                                        version = header.Version,
                                        colorspace = header.Colorspace.ToString(),
                                        flags = GetFlagNames(header.Flags),
                                        fileSize = fileSize
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
                    // Fully stop the previous loop before starting a new one:
                    // two loops over one decoder/file stream interleave chunk
                    // reads and send concurrently on the same socket
                    await StopPlaybackAsync();
                    _isPlaying = true;
                    _cts = new CancellationTokenSource();
                    _playbackTask = StartStreamLoop(ws, _cts.Token);
                }
                else if (msg == "pause")
                {
                    await StopPlaybackAsync();
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Player Socket Error: " + ex.Message);
        }
    }

    private async Task StopPlaybackAsync()
    {
        _isPlaying = false;
        _cts?.Cancel();
        var task = _playbackTask;
        _playbackTask = null;
        if (task != null)
        {
            try { await task; } catch { }
        }
    }

    private async Task PerformSeek(int targetFrame, WebSocket ws)
    {
        await StopPlaybackAsync();

        List<KeyframeInfo> snapshot;
        lock (_lock)
        {
            snapshot = new List<KeyframeInfo>(_keyframes);
        }

        // Closest keyframe at or before the target; fall back to the first
        // keyframe when the target sits before it, and give up cleanly when
        // the index is not available yet
        var candidates = snapshot.Where(k => k.FrameNumber <= targetFrame)
                                 .OrderByDescending(k => k.FrameNumber)
                                 .ToArray();
        KeyframeInfo keyframe;
        if (candidates.Length > 0)
        {
            keyframe = candidates[0];
        }
        else if (snapshot.Count > 0)
        {
            keyframe = snapshot[0];
        }
        else
        {
            Console.WriteLine($"Seek to frame {targetFrame} ignored: keyframe index not available");
            return;
        }

        QovDecoder? decoder;
        lock (_lock)
        {
            decoder = _decoder;
        }
        if (decoder == null) return;

        Console.WriteLine($"Seeking to frame {targetFrame}, using keyframe at {keyframe.FrameNumber} (offset {keyframe.Offset})");

        try
        {
            decoder.Seek(keyframe.Offset, (uint)keyframe.FrameNumber);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Seek failed: {ex.Message}");
            return;
        }

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

    public async Task StartStreamLoop(WebSocket ws, CancellationToken token, int targetFrame = -1)
    {
        await Task.Run(async () => {
             try
            {
                IEnumerable<QovLibrary.QovDecoder.QovDecodedChunk> enumerable;
                lock (_lock)
                {
                    if (_decoder == null) return;
                    enumerable = _decoder.DecodeAll();
                }

                using var enumerator = enumerable.GetEnumerator();

                double fps = _header.FrameRateDen > 0 ? (double)_header.FrameRateNum / _header.FrameRateDen : 30;
                double targetIntervalMs = 1000.0 / fps;
                var stopwatch = new System.Diagnostics.Stopwatch();

                while (true)
                {
                    stopwatch.Restart();

                    if (ws.State != WebSocketState.Open || token.IsCancellationRequested) break;

                    QovLibrary.QovDecoder.QovDecodedChunk? chunk = null;
                    bool hasMore = false;

                    try
                    {
                        lock (_lock)
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
