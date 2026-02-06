using System;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;

namespace QovGui.Services;

public interface IFFmpegService
{
    Task<bool> IsFFmpegInstalledAsync();
    Task<List<string>> GetCamerasAsync();
    Task<List<string>> GetMicrophonesAsync();
    Task<List<ScreenInfo>> GetScreensAsync();
    
    event Action<byte[]>? OnFrameCaptured;
    
    // Returns the started process ID or object appropriately to allow control
    Task StartRecordingAsync(string? videoDevice, string? audioDevice, QovLibrary.QovEncoder encoder, int width, int height, int fps, int keyframeInterval, CancellationToken cancellationToken);
    
    Task ConvertToQovAsync(string inputFile, string outputFile, CancellationToken cancellationToken);
    Task ConvertImageSequenceAsync(string inputPattern, string outputFile, int fps, CancellationToken cancellationToken);
}

public record ScreenInfo(string Name, int X, int Y, int Width, int Height);
