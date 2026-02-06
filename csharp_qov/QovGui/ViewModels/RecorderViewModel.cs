using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QovGui.Services;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using System.Runtime.InteropServices;
using Avalonia.Threading;

namespace QovGui.ViewModels;

public partial class RecorderViewModel : ViewModelBase
{
    private readonly IFFmpegService _ffmpegService;
    private readonly IDialogService _dialogService;
    
    [ObservableProperty] private ObservableCollection<string> _videoDevices = new();
    [ObservableProperty] private string? _selectedVideoDevice;
    
    [ObservableProperty] private ObservableCollection<string> _audioDevices = new();
    [ObservableProperty] private string? _selectedAudioDevice;
    
    [ObservableProperty] private bool _isRecording;
    [ObservableProperty] private string _statusText = "Ready to record";
    
    // Recording Settings
    [ObservableProperty] private ObservableCollection<string> _resolutions = new() { "640x480", "1280x720 (HD)", "1920x1080 (Full HD)" };
    [ObservableProperty] private string _selectedResolution = "1280x720 (HD)";
    
    [ObservableProperty] private ObservableCollection<int> _frameRates = new() { 15, 24, 30 };
    [ObservableProperty] private int _selectedFps = 30;
    
    [ObservableProperty] private ObservableCollection<int> _keyframeIntervals = new() { 15, 30, 60 };
    [ObservableProperty] private int _selectedKeyframeInterval = 30;
    
    [ObservableProperty] private ObservableCollection<string> _colorspaces = new() { "sRGB", "YUV 4:2:0", "YUV 4:2:2", "YUV 4:4:4" };
    [ObservableProperty] private string _selectedColorspace = "YUV 4:2:0";
    
    [ObservableProperty] private ObservableCollection<string> _encodingModes = new() { "Lossless", "Lossy" };
    [ObservableProperty] private string _selectedEncodingMode = "Lossless";
    
    [ObservableProperty] private int _quality = 75;
    
    [ObservableProperty] private Bitmap? _previewImage;
    private WriteableBitmap? _previewBitmap;

    // Recording Stats
    [ObservableProperty] private string _recordingDuration = "0:00";
    [ObservableProperty] private int _frameCount = 0;
    [ObservableProperty] private int _keyframeCount = 0;
    [ObservableProperty] private string _estimatedSize = "0 KB";
    [ObservableProperty] private string _actualFps = "-";

    private CancellationTokenSource? _recordingCts;
    private DateTime? _startTime;
    private System.Timers.Timer? _statsTimer;

    public RecorderViewModel(IFFmpegService ffmpegService, IDialogService dialogService)
    {
        _ffmpegService = ffmpegService;
        _dialogService = dialogService;
        
        _ffmpegService.OnFrameCaptured += HandleFrameCaptured;
        LoadDevicesAsync();
    }
    
    private void HandleFrameCaptured(byte[] rgbaData)
    {
        Dispatcher.UIThread.Post(() => 
        {
            try 
            {
                int width = 0;
                int height = 0;
                if (SelectedResolution.Contains("640x480")) { width = 640; height = 480; }
                else if (SelectedResolution.Contains("1280x720")) { width = 1280; height = 720; }
                else if (SelectedResolution.Contains("1920x1080")) { width = 1920; height = 1080; }
                
                if (width == 0 || height == 0) return;

                if (_previewBitmap == null || _previewBitmap.PixelSize.Width != width || _previewBitmap.PixelSize.Height != height)
                {
                    _previewBitmap = new WriteableBitmap(new Avalonia.PixelSize(width, height), new Avalonia.Vector(96, 96), PixelFormat.Rgba8888, AlphaFormat.Premul);
                    PreviewImage = _previewBitmap;
                }

                using (var locked = _previewBitmap.Lock())
                {
                    Marshal.Copy(rgbaData, 0, locked.Address, rgbaData.Length);
                }
                
                // Notify UI of change (though pointing to same object, we might need a refresh)
                // In Avalonia, WriteableBitmap usually needs a manual refresh if not using interop
                // Actually, just setting PreviewImage = _previewBitmap might not trigger redraw if it's the same ref.
                // But we can call OnPropertyChanged(nameof(PreviewImage))
                OnPropertyChanged(nameof(PreviewImage));
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Preview Error: {ex.Message}");
            }
        });
    }
    
    public RecorderViewModel()
    {
        _ffmpegService = null!;
        _dialogService = null!;
        VideoDevices.Add("Design Camera");
        SelectedVideoDevice = "Design Camera";
    }

    private async void LoadDevicesAsync()
    {
        try
        {
            if (!await _ffmpegService.IsFFmpegInstalledAsync())
            {
                StatusText = "FFmpeg not found! Please install FFmpeg.";
                return;
            }

            var cams = await _ffmpegService.GetCamerasAsync();
            VideoDevices.Clear();
            foreach (var cam in cams) VideoDevices.Add(cam);
            
            // Add Screens
            var screens = await _ffmpegService.GetScreensAsync();
            foreach (var s in screens)
            {
                VideoDevices.Insert(0, s.Name);
            }
            
            if (VideoDevices.Count > 0)
            {
                SelectedVideoDevice = VideoDevices[0];
            }

            var mics = await _ffmpegService.GetMicrophonesAsync();
            AudioDevices.Clear();
            foreach (var mic in mics) AudioDevices.Add(mic);
            if (AudioDevices.Count > 0) SelectedAudioDevice = AudioDevices[0];
        }
        catch (Exception ex)
        {
            StatusText = $"Error loading devices: {ex.Message}";
        }
    }

    [RelayCommand]
    public void Initialize()
    {
         LoadDevicesAsync(); // Reload
    }

    [RelayCommand]
    public async Task ToggleRecordingAsync()
    {
        if (IsRecording)
        {
            StopRecording();
        }
        else
        {
            await StartRecordingAsync();
        }
    }

    private async Task StartRecordingAsync()
    {
        var path = await _dialogService.ShowSaveFileDialogAsync("Save Recording", "qov", "recording");
        if (string.IsNullOrEmpty(path)) return;

        IsRecording = true;
        StatusText = "Recording...";
        _recordingCts = new CancellationTokenSource();
        
        // Determine device
        string? videoDev = SelectedVideoDevice == "Screen Capture" ? null : SelectedVideoDevice;
        string? audioDev = SelectedAudioDevice;
        
        _ = Task.Run(async () => 
        {
            FileStream? fs = null;
            try
            {
                // Parse resolution
                int width = 640;
                int height = 480;
                if (SelectedResolution.Contains("1280x720")) { width = 1280; height = 720; }
                else if (SelectedResolution.Contains("1920x1080")) { width = 1920; height = 1080; }

                byte colorspace = 0x10; // YUV420
                if (SelectedColorspace == "sRGB") colorspace = 0x00;
                else if (SelectedColorspace == "YUV 4:2:2") colorspace = 0x11;
                else if (SelectedColorspace == "YUV 4:4:4") colorspace = 0x12;

                bool isLossy = SelectedEncodingMode == "Lossy";

                fs = File.Create(path);
                var encoder = new QovLibrary.QovEncoder(fs, (ushort)width, (ushort)height, (ushort)SelectedFps, colorspace: colorspace, quality: isLossy ? Quality : 100);
                
                // Reset stats
                Avalonia.Threading.Dispatcher.UIThread.Post(() => {
                    FrameCount = 0;
                    KeyframeCount = 0;
                    RecordingDuration = "0:00";
                    EstimatedSize = "0 KB";
                    ActualFps = "-";
                    _startTime = DateTime.Now;
                    _statsTimer = new System.Timers.Timer(1000);
                    _statsTimer.Elapsed += (s, e) => {
                        if (_startTime.HasValue) {
                            var elapsed = DateTime.Now - _startTime.Value;
                            Avalonia.Threading.Dispatcher.UIThread.Post(() => {
                                RecordingDuration = $"{(int)elapsed.TotalMinutes:00}:{elapsed.Seconds:00}";
                                ActualFps = (FrameCount / elapsed.TotalSeconds).ToString("F1");
                                EstimatedSize = SizeToString((uint)fs.Length);
                            });
                        }
                    };
                    _statsTimer.Start();
                });

                await _ffmpegService.StartRecordingAsync(videoDev, audioDev, encoder, width, height, SelectedFps, SelectedKeyframeInterval, _recordingCts.Token);
                
                // Finish encoding
                encoder.Finish();
            }
            catch (Exception ex)
            {
                Avalonia.Threading.Dispatcher.UIThread.Post(() => 
                {
                    StatusText = $"Recording Error: {ex.Message}";
                    IsRecording = false;
                    _statsTimer?.Stop();
                });
            }
            finally
            {
                fs?.Dispose();
                _statsTimer?.Stop();
                Avalonia.Threading.Dispatcher.UIThread.Post(() => 
                {
                    if (IsRecording) {
                        IsRecording = false;
                        StatusText = "Recording Saved.";
                    }
                });
            }
        });
    }

    private string SizeToString(uint bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F2} KB";
        return $"{bytes / 1024.0 / 1024.0:F2} MB";
    }

    private void StopRecording()
    {
        _recordingCts?.Cancel();
        StatusText = "Stopping...";
        // IsRecording will be set to false in finally block
    }
}
