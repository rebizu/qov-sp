using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QovGui.Services;

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
    
    private CancellationTokenSource? _recordingCts;

    public RecorderViewModel(IFFmpegService ffmpegService, IDialogService dialogService)
    {
        _ffmpegService = ffmpegService;
        _dialogService = dialogService;
        
        LoadDevicesAsync();
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
            
            // Add "Screen" option
            VideoDevices.Insert(0, "Screen Capture");
            SelectedVideoDevice = VideoDevices[0];

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
        
        // Default settings
        int width = 640;
        int height = 480; 
        int fps = 30;

        _ = Task.Run(async () => 
        {
            FileStream? fs = null;
            try
            {
                fs = File.Create(path);
                var encoder = new QovLibrary.QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);
                
                await _ffmpegService.StartRecordingAsync(videoDev, audioDev, encoder, width, height, _recordingCts.Token);
                
                // Finish encoding
                encoder.Finish();
            }
            catch (Exception ex)
            {
                Avalonia.Threading.Dispatcher.UIThread.Post(() => 
                {
                    StatusText = $"Recording Error: {ex.Message}";
                    IsRecording = false;
                });
            }
            finally
            {
                fs?.Dispose();
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

    private void StopRecording()
    {
        _recordingCts?.Cancel();
        StatusText = "Stopping...";
        // IsRecording will be set to false in finally block
    }
}
