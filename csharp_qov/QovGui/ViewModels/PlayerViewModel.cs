using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QovGui.Services;
using QovLibrary;

namespace QovGui.ViewModels;

public class ChunkInfo
{
    public string TypeName { get; set; } = "";
    public string Size { get; set; } = "";
    public long Offset { get; set; }
    public string Color { get; set; } = "#ffffff";
    public string BackgroundColor { get; set; } = "Transparent";
    public bool IsCompressed { get; set; }
}

public partial class PlayerViewModel : ViewModelBase, IDisposable
{
    private readonly IDialogService _dialogService;
    private readonly IAudioService _audioService;
    
    [ObservableProperty] private WriteableBitmap? _videoFrame;
    [ObservableProperty] private string _statusText = "Ready";
    [ObservableProperty] private bool _isPlaying;
    [ObservableProperty] private double _progress;
    [ObservableProperty] private string _durationText = "00:00";
    [ObservableProperty] private string _currentTimeText = "00:00";

    // Header Info
    [ObservableProperty] private string _resolution = "-";
    [ObservableProperty] private string _frameRate = "-";
    [ObservableProperty] private string _totalFrames = "-";
    [ObservableProperty] private string _fileSize = "-";
    [ObservableProperty] private string _codecInfo = "-";
    [ObservableProperty] private string _colorspaceInfo = "-";

    // Playback Info
    [ObservableProperty] private string _currentFrameIndex = "-";
    [ObservableProperty] private string _currentFrameType = "-";
    [ObservableProperty] private string _currentTimestamp = "-";
    [ObservableProperty] private string _decodeFps = "-"; // Bonus

    // Playback Control
    [ObservableProperty] private double _playbackSpeed = 1.0;
    
    private string? _currentFilePath;

    private CancellationTokenSource? _playbackCts;
    private Stream? _fileStream;
    private QovDecoder? _decoder;
    private QovHeader? _header;
    
    private byte[]? _renderBuffer;

    [ObservableProperty] private System.Collections.ObjectModel.ObservableCollection<ChunkInfo> _chunks = new();

    public PlayerViewModel(IDialogService dialogService, IAudioService audioService)
    {
        _dialogService = dialogService;
        _audioService = audioService;
    }
    
    // Default constructor for design time
    public PlayerViewModel() 
    {
        _dialogService = null!;
        _audioService = null!;
    }

    [RelayCommand]
    public async Task OpenFileAsync()
    {
        var path = await _dialogService.ShowOpenFileDialogAsync("Open QOV File", new[] { "qov" });
        if (!string.IsNullOrEmpty(path))
        {
            await LoadFileAsync(path);
        }
    }



    [RelayCommand]
    public void TogglePlayPause()
    {
        if (IsPlaying)
        {
            StopPlayback();
        }
        else
        {
            if (_fileStream != null)
            {
                StartPlayback();
            }
        }
    }

    [RelayCommand]
    public void RestartPlayback()
    {
        if (_fileStream == null || string.IsNullOrEmpty(_currentFilePath)) return;
        _playbackCts?.Cancel(); // Stop current playback
        IsPlaying = false;
        
        try 
        {
            // Re-open stream
            DisposeFile();
            
            _fileStream = File.OpenRead(_currentFilePath);
            _decoder = new QovDecoder(_fileStream);
            _header = _decoder.DecodeHeader();
            
            // Render first frame (Keyframe 0)
            var frames = _decoder.DecodeFrames().GetEnumerator();
            if (frames.MoveNext())
            {
                var frame = frames.Current;
                UpdateVideoSurface(frame.Pixels);
                UpdateUI(frame);
            }
            
            StatusText = $"Restarted playback.";
        }
        catch (Exception ex)
        {
            StatusText = $"Error restarting: {ex.Message}";
        }
    }

    [RelayCommand]
    public async Task NextFrameAsync()
    {
        if (IsPlaying) TogglePlayPause();
        if (_decoder == null) return;

        // How to peek/read next frame without consuming the stream permanently vs PlaybackLoop?
        // QovDecoder reads from underlying stream.
        // If we read one frame here, the stream position advances. 
        // Next time PlaybackLoop starts, it continues from there. Correct.
        // ISSUE: QovDecoder.DecodeFrames() yields a NEW enumerator.
        // It uses "yield return".
        // Calling DecodeFrames() again starts a NEW enumerator loop.
        // Does DecodeAll() reset state?
        // It loops "while(true)". It reads next chunk.
        // So yes, calling DecodeFrames().First() works correctly to advance state 1 step.
        
        // We need run on background to avoid blocking UI with IO/Decode
        await Task.Run(() => 
        {
            try
            {
                // We create a new enumerator, take 1, and dispose.
                // Since _decoder holds the state (BinaryReader), this advances the underlying stream.
                // However, QovDecoder maintains internal state (_currFrame, etc).
                // Safe to use? Yes.
                
                foreach (var frame in _decoder.DecodeFrames())
                {
                    UpdateVideoSurface(frame.Pixels);
                    Avalonia.Threading.Dispatcher.UIThread.Post(() => UpdateUI(frame));
                    break; // Take 1
                }
            }
            catch (Exception ex)
            {
                 Avalonia.Threading.Dispatcher.UIThread.Post(() => StatusText = $"Next Frame Error: {ex.Message}");
            }
        });
    }

    [RelayCommand]
    public async Task NextKeyframeAsync()
    {
        if (IsPlaying) TogglePlayPause();
        if (_decoder == null) return;

        StatusText = "Seeking next keyframe...";

        await Task.Run(() => 
        {
            try
            {
                // Loop until we find a keyframe or end
                foreach (var frame in _decoder.DecodeFrames())
                {
                    if (frame.IsKeyframe)
                    {
                        UpdateVideoSurface(frame.Pixels);
                        Avalonia.Threading.Dispatcher.UIThread.Post(() => UpdateUI(frame));
                        break; // Found it
                    }
                    // Else consume P-frame and continue
                }
                Avalonia.Threading.Dispatcher.UIThread.Post(() => StatusText = "Seek Complete");
            }
            catch (Exception ex)
            {
                 Avalonia.Threading.Dispatcher.UIThread.Post(() => StatusText = $"Seek Error: {ex.Message}");
            }
        });
    }

    private void UpdateUI(QovFrame frame)
    {
        if (_header == null) return;
        double currentTime = frame.FrameNumber / (double)_header.Value.FrameRateNum;
        CurrentTimeText = FormatTime(currentTime);
        Progress = (double)frame.FrameNumber / _header.Value.TotalFrames;
        
        CurrentFrameIndex = frame.FrameNumber.ToString();
        CurrentFrameType = frame.IsKeyframe ? "Keyframe" : "P-Frame";
        CurrentTimestamp = $"{currentTime:F3}s";
    }

    [ObservableProperty] private WriteableBitmap? _chunkTimelineBitmap;

    private async Task LoadFileAsync(string path)
    {
        StopPlayback();
        DisposeFile();

        try
        {
            _currentFilePath = path;
            _fileStream = File.OpenRead(path);
            _decoder = new QovDecoder(_fileStream);
            _header = _decoder.DecodeHeader();
            
            // Populate Header Info
            Resolution = $"{_header.Value.Width}x{_header.Value.Height}";
            FrameRate = $"{_header.Value.FrameRateNum} fps";
            TotalFrames = _header.Value.TotalFrames.ToString();
            CodecInfo = $"{_header.Value.Magic} v{_header.Value.Version}";
            Resolution = $"{_header.Value.Width}x{_header.Value.Height}";
            FrameRate = $"{_header.Value.FrameRateNum} fps";
            TotalFrames = _header.Value.TotalFrames.ToString();
            CodecInfo = $"{_header.Value.Magic} v{_header.Value.Version}";
            FileSize = SizeToString((uint)new FileInfo(path).Length);
            ColorspaceInfo = FormatColorspace(_header.Value.Colorspace);
            
            StatusText = $"Loaded {Path.GetFileName(path)}";
            DurationText = FormatTime(_header.Value.TotalFrames / (double)_header.Value.FrameRateNum);
            
            // Reset Playback Info
            CurrentFrameIndex = "0";
            CurrentFrameType = "-";
            CurrentTimestamp = "0:00";

            // Create WriteableBitmap for video surface
            VideoFrame = new WriteableBitmap(new Avalonia.PixelSize(_header.Value.Width, _header.Value.Height), new Avalonia.Vector(96, 96), Avalonia.Platform.PixelFormat.Rgba8888, Avalonia.Platform.AlphaFormat.Premul);
            _renderBuffer = new byte[_header.Value.Width * _header.Value.Height * 4];

            // Render first frame (Keyframe 0) so it's not black on load
            var firstFrames = _decoder.DecodeFrames().GetEnumerator();
            if (firstFrames.MoveNext())
            {
                var frame = firstFrames.Current;
                UpdateVideoSurface(frame.Pixels);
                UpdateUI(frame);
            }

            // Generate Timeline Analysis
            await GenerateTimelineAsync(path);
        }
        catch (Exception ex)
        {
            StatusText = $"Error loading file: {ex.Message}";
            await _dialogService.ShowAlertAsync("Error", ex.Message);
        }
    }

    private async Task GenerateTimelineAsync(string path)
    {
        await Task.Run(() =>
        {
            try 
            {
                using var fs = File.OpenRead(path);
                using var reader = new BinaryReader(fs);

                // Read basic header manually to get offset
                reader.BaseStream.Seek(0, SeekOrigin.Begin);
                byte[] magic = reader.ReadBytes(4);
                if (System.Text.Encoding.ASCII.GetString(magic) != "qovf") return;
                byte ver = reader.ReadByte();
                bool use32Bit = ver >= 2;
                bool isLossy = ver == 3;
                
                int headerSize = isLossy ? 32 : 24;
                reader.BaseStream.Seek(headerSize, SeekOrigin.Begin);

                // Prepare Bitmap
                int width = 1000;
                int height = 20; // User requested 20px
                var bitmap = new WriteableBitmap(new Avalonia.PixelSize(width, height), new Avalonia.Vector(96, 96), Avalonia.Platform.PixelFormat.Bgra8888, Avalonia.Platform.AlphaFormat.Premul);
                
                var chunkList = new System.Collections.ObjectModel.ObservableCollection<ChunkInfo>();
                
                using (var fb = bitmap.Lock())
                {
                    // Clear background (Transparent/Dark)
                    unsafe 
                    {
                        uint* ptr = (uint*)fb.Address;
                        for (int i = 0; i < width * height; i++) ptr[i] = 0xFF1e1e2d; // Dark background
                    }

                    long fileSize = fs.Length;
                    double framesPerPixel = 1;
                    if (_header.HasValue && _header.Value.TotalFrames > 0)
                        framesPerPixel = (double)_header.Value.TotalFrames / width;
                    
                    int frameIndex = 0;
                    
                    // Limit UI list items to improve performance
                    int maxListItems = 500; 

                    while (reader.BaseStream.Position < fileSize)
                    {
                        long chunkOffset = reader.BaseStream.Position;
                        byte type = reader.ReadByte();
                        if (type == 0xFF) break; // QOV_CHUNK_END (Fixed from 0xFE)
                        
                        // Check for EOF before reading payload info
                        if (reader.BaseStream.Position + 9 > fileSize) break; 

                        byte flags = reader.ReadByte();
                        uint size = use32Bit ? UtilReadBigEndianU32(reader) : UtilReadBigEndianU16(reader);
                        uint time = UtilReadBigEndianU32(reader);
                        
                        string typeName = "Unknown";
                        string colorHex = "#64748b"; // Gray
                        string bgHex = "#20000000"; // Default
                        uint bitmapColor = 0xFF64748b;
                        bool compressed = (flags & 0x10) != 0; // bit 4 = QOV_CHUNK_FLAG_COMPRESSED

                        if (type == 0x01) { 
                            typeName = "KEYFRAME"; 
                            colorHex = "#fbbf24"; 
                            bgHex = "#1Afbbf24"; 
                            bitmapColor = 0xFF24BFFB; 
                        } 
                        else if (type == 0x02) { 
                            typeName = "PFRAME"; 
                            colorHex = "#3b82f6"; 
                            bgHex = "#1A3b82f6"; 
                            bitmapColor = 0xFFF6823B; 
                        } 
                        else if (type == 0x03) { 
                            typeName = "BFRAME"; 
                            colorHex = "#22c55e"; 
                            bgHex = "#1A22c55e"; 
                            bitmapColor = 0xFF5EC522; 
                        } 
                        else if (type == 0x10) { 
                            typeName = "AUDIO"; 
                            colorHex = "#a855f7"; 
                            bgHex = "#1Aa855f7"; 
                            bitmapColor = 0xFFF755A8; 
                        } 
                        else if (type == 0x00) {
                            typeName = "SYNC";
                            colorHex = "#22c55e";
                            bgHex = "#1A22c55e";
                            bitmapColor = 0xFF5EC522;
                        }

                        // Add to list
                        if (chunkList.Count < maxListItems)
                        {
                            chunkList.Add(new ChunkInfo 
                            { 
                                TypeName = typeName, 
                                Offset = chunkOffset, 
                                Size = SizeToString(size),
                                Color = colorHex,
                                BackgroundColor = bgHex,
                                IsCompressed = compressed
                            });
                        }

                        // Map frame index to X (Video frames only)
                        bool isVideo = type == 0x01 || type == 0x02 || type == 0x03;
                        if (isVideo)
                        {
                            int x = (int)(frameIndex / framesPerPixel);
                            if (x >= 0 && x < width)
                            {
                                unsafe
                                {
                                    uint* ptr = (uint*)fb.Address;
                                    for (int y = 0; y < height; y++)
                                    {
                                        ptr[y * width + x] = bitmapColor;
                                    }
                                }
                            }
                            frameIndex++;
                        }
                        
                        // Skip payload
                        if (reader.BaseStream.Position + size <= fileSize)
                        {
                            reader.BaseStream.Seek(size, SeekOrigin.Current);
                        }
                        else
                        {
                             break; // Avoid seek past EOF
                        }
                    }
                }
                
                Avalonia.Threading.Dispatcher.UIThread.Post(() => 
                {
                    ChunkTimelineBitmap = bitmap;
                    Chunks = chunkList;
                });
            }
            catch (Exception ex) 
            {
                 Avalonia.Threading.Dispatcher.UIThread.Post(() => {
                     // StatusText = $"Timeline Error: {ex.Message}"; // Can be noisy
                     System.Diagnostics.Debug.WriteLine($"Timeline Error: {ex}");
                 });
            }
        });
    }

    private string SizeToString(uint bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes / 1024.0 / 1024.0:F2} MB";
    }



    private string FormatColorspace(byte cs)
    {
        switch (cs) {
            case 0x00: return "sRGB";
            case 0x01: return "sRGBA";
            case 0x02: return "Linear RGB";
            case 0x03: return "Linear RGBA";
            case 0x10: return "YUV 4:2:0";
            case 0x11: return "YUV 4:2:2";
            case 0x12: return "YUV 4:4:4";
            case 0x13: return "YUVA 4:2:0";
            default: return $"Unknown (0x{cs:X2})";
        }
    }

    private uint UtilReadBigEndianU16(BinaryReader r)
    {
        byte[] b = r.ReadBytes(2);
        return (uint)((b[0] << 8) | b[1]);
    }
    
    private uint UtilReadBigEndianU32(BinaryReader r)
    {
        byte[] b = r.ReadBytes(4);
        return (uint)((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]);
    }

    private void StartPlayback()
    {
        if (_fileStream == null || _decoder == null || _header == null) return;
        
        IsPlaying = true;
        _playbackCts = new CancellationTokenSource();
        
        Task.Run(() => PlaybackLoopAsync(_playbackCts.Token));
    }

    private void StopPlayback()
    {
        _playbackCts?.Cancel();
        IsPlaying = false;
    }

    private async Task PlaybackLoopAsync(CancellationToken token)
    {
        try 
        {
            if (_header == null || _decoder == null) return;
            var header = _header.Value;

            // Frame delay
            int delayMs = 1000 / header.FrameRateNum;
            
            // This is a naive loop. Ideally we sync with audio or clock.
            foreach (var frame in _decoder.DecodeFrames())
            {
                if (token.IsCancellationRequested) break;

                if (frame.IsKeyframe)
                {
                    // Render Keyframe
                    UpdateVideoSurface(frame.Pixels);
                }
                else
                {
                    // PFrame -> Update surface
                    UpdateVideoSurface(frame.Pixels);
                }
                
                // Update UI
                Avalonia.Threading.Dispatcher.UIThread.Post(() => UpdateUI(frame));

                int effectiveDelay = (int)(delayMs / PlaybackSpeed);
                if (effectiveDelay < 1) effectiveDelay = 1;
                await Task.Delay(effectiveDelay, token);
            }
        }
        catch (Exception ex)
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() => StatusText = $"Playback Error: {ex.Message}");
        }
        finally
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() => IsPlaying = false);
        }
    }

    private void UpdateVideoSurface(byte[] pixels)
    {
        if (VideoFrame == null) return;

        using var frameBuffer = VideoFrame.Lock();
        // Copy pixels to WriteableBitmap
        // Assuming pixels are Rgba8888 (QOV decoded data is RGBA)
        // Avalonia expects BGRA usually? Or we specified Rgba8888 in constructor.
        // If system uses BGRA, we might need conversion. 
        // Avalonia PixelFormat.Rgba8888 should handle it.
        
        // Marshal copy
        System.Runtime.InteropServices.Marshal.Copy(pixels, 0, frameBuffer.Address, pixels.Length);
        
        // Use dispatcher to notify change? No, Lock() and Dispose() handles it usually, but we need to trigger Invalidate?
        // Avalonia WriteableBitmap updates automatically on Dispose of lock? 
        // We might need to raise property changed on VideoFrame if the object instance changed, but here content changed.
        // Actually, we must use `Dispatcher` to update UI bound bitmap? 
        // No, `VideoFrame` is bound. The bitmap content update happens on background thread here.
        // This is safe in Avalonia if we lock properly.
        Avalonia.Threading.Dispatcher.UIThread.Post(() => 
        {
             // Force redraw if needed. Usually automatic.
             // But we are binding to an object.
        });
    }

    private string FormatTime(double seconds)
    {
        var ts = TimeSpan.FromSeconds(seconds);
        return $"{(int)ts.TotalMinutes:00}:{ts.Seconds:00}";
    }
    
    private void DisposeFile()
    {
        _fileStream?.Dispose();
        _fileStream = null;
        _decoder = null;
        _header = null;
    }

    public void Dispose()
    {
        StopPlayback();
        DisposeFile();
        VideoFrame?.Dispose();
    }
}
