using System;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QovGui.Services;

namespace QovGui.ViewModels;

public partial class ConverterViewModel : ViewModelBase
{
    private readonly IFFmpegService _ffmpegService;
    private readonly IDialogService _dialogService;
    
    [ObservableProperty] private string _statusText = "Ready to convert";
    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private double _progress; // Not really used yet for determinate progress

    public ConverterViewModel(IFFmpegService ffmpegService, IDialogService dialogService)
    {
        _ffmpegService = ffmpegService;
        _dialogService = dialogService;
    }
    
    public ConverterViewModel()
    {
        _ffmpegService = null!;
        _dialogService = null!;
    }

    [RelayCommand]
    public async Task ConvertVideoAsync()
    {
        if (IsBusy) return;
        
        var inputPath = await _dialogService.ShowOpenFileDialogAsync("Select Video File", new[] { "mp4", "avi", "mkv", "mov" });
        if (string.IsNullOrEmpty(inputPath)) return;
        
        var outputPath = await _dialogService.ShowSaveFileDialogAsync("Save QOV File", "qov", System.IO.Path.GetFileNameWithoutExtension(inputPath));
        if (string.IsNullOrEmpty(outputPath)) return;

        await RunConversionAsync(async (token) => 
        {
            await _ffmpegService.ConvertToQovAsync(inputPath, outputPath, token);
        });
    }

    [RelayCommand]
    public async Task ConvertImagesAsync()
    {
        if (IsBusy) return;

        // For image sequence, usually we select the first image or a folder? 
        // Let's assume selecting the first image "img_001.png" implies "img_%03d.png" logic or similar.
        // OR we can ask for a pattern directly?
        // Simpler for GUI: Select the first file, we try to deduce pattern?
        // Or just Select File (First Image).
        
        var inputPath = await _dialogService.ShowOpenFileDialogAsync("Select First Image of Sequence", new[] { "png", "jpg", "jpeg" });
        if (string.IsNullOrEmpty(inputPath)) return;
        
        // Try to guess pattern?
        // simple heuristic: if ends with digits, replace with %0xd
        // This is complex to get right automatically.
        // For now, let's assume the user selects a file and we assume it is part of a sequence that FFmpeg understands if we just pass the file? 
        // No, FFmpeg needs %03d.
        
        // Let's just prompt for pattern? No, too hard.
        // Let's deduce:
        // img_001.png -> img_%03d.png
        
        string directory = System.IO.Path.GetDirectoryName(inputPath) ?? "";
        string filename = System.IO.Path.GetFileName(inputPath);
        string extension = System.IO.Path.GetExtension(inputPath);
        string nameNoExt = System.IO.Path.GetFileNameWithoutExtension(inputPath);
        
        string pattern = inputPath; // Default to single file if no digits
        
        // Find trailing digits
        var match = System.Text.RegularExpressions.Regex.Match(nameNoExt, @"(\d+)$");
        if (match.Success)
        {
            int digits = match.Groups[1].Length;
            string prefix = nameNoExt.Substring(0, nameNoExt.Length - digits);
             // Build pattern, e.g. path/to/img_%03d.png
            pattern = System.IO.Path.Combine(directory, $"{prefix}%0{digits}d{extension}");
        }

        var outputPath = await _dialogService.ShowSaveFileDialogAsync("Save QOV File", "qov", prefixName(nameNoExt));
        if (string.IsNullOrEmpty(outputPath)) return;
        
        // Default FPS 30
        int fps = 30;

        await RunConversionAsync(async (token) => 
        {
            await _ffmpegService.ConvertImageSequenceAsync(pattern, outputPath, fps, token);
        });
    }

    private string prefixName(string n)
    {
         var match = System.Text.RegularExpressions.Regex.Match(n, @"^(.*?)(\d+)$");
         if (match.Success) return match.Groups[1].Value;
         return n;
    }

    private async Task RunConversionAsync(Func<CancellationToken, Task> action)
    {
        IsBusy = true;
        StatusText = "Converting...";
        var cts = new CancellationTokenSource();
        
        try 
        {
            await Task.Run(async () => await action(cts.Token));
            StatusText = "Conversion Complete!";
        }
        catch (Exception ex)
        {
             StatusText = $"Error: {ex.Message}";
        }
        finally
        {
             IsBusy = false;
        }
    }
}
