using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using FFMpegCore;
using FFMpegCore.Pipes;
using System.Linq;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace QovGui.Services;

public class FFmpegService : IFFmpegService
{
    public Task<bool> IsFFmpegInstalledAsync()
    {
        // FFMpegCore usually requires ffmpeg/ffprobe in PATH.
        // We can check version to verify.
        try
        {
            // FFMpegCore doesn't have a direct "IsInstalled" check that returns boolean without throwing?
            // GlobalFFOptions.GetFFMpegBinary() returns the path.
            // We can try running a simple probe or version check.
            // But FFMpegCore is a wrapper. 
            // Let's assume true if we can get the path, or try a dummy call.
            var path = GlobalFFOptions.GetFFMpegBinaryPath();
            return Task.FromResult(!string.IsNullOrEmpty(path));
        }
        catch
        {
            return Task.FromResult(false);
        }
    }

    public async Task<List<string>> GetCamerasAsync()
    {
        var devices = new List<string>();
        if (OperatingSystem.IsWindows())
        {
            // FFMpegCore doesn't have built-in support for listing dshow devices nicely.
            // We have to parse output of "ffmpeg -list_devices true -f dshow -i dummy"
            // We'll run this process manually as FFMpegCore is focused on conversions.
            try 
            {
               string output = await ReadFFmpegOutputAsync("-list_devices true -f dshow -i dummy");
               devices = ParseFFmpegDevices(output, "video");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error listing cameras: {ex.Message}");
            }
        }
        // Add "Screen Capture" as specialized virtual device?
        // Actually, MainWindow expects strings.
        // We can add "Screen Capture" here if consistent with UI.
        // But UI might add it separately.
        return devices;
    }

    public async Task<List<string>> GetMicrophonesAsync()
    {
        var devices = new List<string>();
        if (OperatingSystem.IsWindows())
        {
             try 
            {
               string output = await ReadFFmpegOutputAsync("-list_devices true -f dshow -i dummy");
               devices = ParseFFmpegDevices(output, "audio");
            }
            catch (Exception ex)
            {
                 Console.WriteLine($"Error listing mics: {ex.Message}");
            }
        }
        return devices;
    }

    public async Task StartRecordingAsync(string videoDevice, string audioDevice, QovLibrary.QovEncoder encoder, int width, int height, CancellationToken token)
    {
        // 1. Configure Input
        // If "Screen Capture", we use gdigrab on Windows.
        // If device, use dshow.
        
        // Build arguments for FFMpegCore manually or use builder?
        // FFMpegCore builder is nice but dealing with raw output pipe requires care.
        // Input:
        // FFMpegArguments.FromDevice(...) ? 
        // No, FromDevice is for simple cases. We need custom args for dshow?
        // Actually FFMpegArguments.FromUrlInput is generic.
        FFMpegArguments args;
        
        if (videoDevice == "Screen Capture")
        {
             if (OperatingSystem.IsWindows())
             {
                 args = FFMpegArguments
                    .FromUrlInput(new Uri("desktop"), options => options
                        .WithCustomArgument("-f gdigrab")
                        .WithFramerate(30));
             }
             else
             {
                 throw new PlatformNotSupportedException("Screen capture only implemented for Windows (gdigrab) in this demo.");
             }
        }
        else
        {
             // Webcam
             // Construct dshow input string: video=DeviceName[:audio=MicName]
             string videoInput = $"video={videoDevice}";
             if (!string.IsNullOrEmpty(audioDevice))
             {
                 videoInput += $":audio={audioDevice}";
             }
             
             // Use Uri for FromUrlInput. "video=..." is treated as scheme "video" which is valid URI syntax.
             // This bypasses FFMpegCore's validation while passing the correct string to ffmpeg.
             args = FFMpegArguments
                .FromUrlInput(new Uri(videoInput), options => options
                    .WithCustomArgument("-f dshow"));
        }

        // Output: Raw Pipe -> Encoder
        await args
            .OutputToPipe(new StreamPipeSink(async (stream, cancellationToken) => 
            {
                 int frameSize = width * height * 4;
                 byte[] buffer = new byte[frameSize];
                 uint frameIdx = 0;
                 // Use 33ms per frame (~30fps) for timestamps if not strictly provided
                 // QovEncoder expects generic time units (usually ms or similar?) 
                 // Previous conversion used 33.
                 
                 while (await ReadExactAsync(stream, buffer, frameSize, token))
                 {
                      encoder.EncodeKeyframe(buffer, frameIdx * 33);
                      frameIdx++;
                 }
            }), options => options
                .ForceFormat("rawvideo")
                .ForcePixelFormat("rgba"))
            .ProcessAsynchronously();
    }
    
    private async Task<string> ReadFFmpegOutputAsync(string args)
    {
         var process = new Process
         {
             StartInfo = new ProcessStartInfo
             {
                 FileName = GlobalFFOptions.GetFFMpegBinaryPath(),
                 Arguments = args,
                 RedirectStandardError = true, // ffmpeg prints list to stderr
                 UseShellExecute = false,
                 CreateNoWindow = true
             }
         };
         
         process.Start();
         string output = await process.StandardError.ReadToEndAsync();
         await process.WaitForExitAsync();
         return output;
    }

    private List<string> ParseFFmpegDevices(string output, string type)
    {
         var list = new List<string>();
         var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
         bool correctType = false;
         
         foreach (var line in lines)
         {
             if (line.Contains($"DirectShow {type} devices"))
             {
                 correctType = true;
                 continue;
             }
             if (line.Contains("DirectShow") && !line.Contains(type))
             {
                 correctType = false;
             }
             
             if (correctType)
             {
                 var match = Regex.Match(line, "\"(.*)\"");
                 if (match.Success)
                 {
                     list.Add(match.Groups[1].Value);
                 }
             }
         }
         
         return list.Distinct().ToList();
    }

    public async Task ConvertToQovAsync(string inputPath, string outputPath, CancellationToken token)
    {
         var analysis = await FFProbe.AnalyseAsync(inputPath);
         var video = analysis.PrimaryVideoStream;
         if (video == null) throw new InvalidOperationException("No video stream found.");
         
         int width = video.Width;
         int height = video.Height;
         int fps = (int)video.FrameRate;
         
         using var fs = File.Create(outputPath);
         var encoder = new QovLibrary.QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);
         
         int frameSize = width * height * 4;
         byte[] buffer = new byte[frameSize];
         
         await FFMpegArguments
            .FromFileInput(inputPath)
            .OutputToPipe(new StreamPipeSink(async (stream, cancellationToken) => 
            {
                 uint frameIdx = 0;
                 while (await ReadExactAsync(stream, buffer, frameSize, token)) // Use outer token
                 {
                      encoder.EncodeKeyframe(buffer, frameIdx * 33); 
                      frameIdx++;
                 }
                 encoder.Finish();
            }), options => options
                .ForceFormat("rawvideo")
                .ForcePixelFormat("rgba"))
            .ProcessAsynchronously();
    }

    public async Task ConvertImageSequenceAsync(string pattern, string outputPath, int fps, CancellationToken token)
    {
         string probeFile = Regex.Replace(pattern, "%0\\d+d", "001"); 
         
         // Fix usage: AnalyseAsync inputs file path?
         // If file doesn't exist, this throws.
         // Let's assume user provides valid pattern where 001 exists.
         var ANALYSIS = await FFProbe.AnalyseAsync(probeFile); 
         var video = ANALYSIS.PrimaryVideoStream;
         if (video == null) throw new InvalidOperationException("No video info found.");

         int width = video.Width;
         int height = video.Height;
         
         using var fs = File.Create(outputPath);
         var encoder = new QovLibrary.QovEncoder(fs, (ushort)width, (ushort)height, (ushort)fps);
         
         int frameSize = width * height * 4;
         byte[] buffer = new byte[frameSize];
         
         await FFMpegArguments
            .FromUrlInput(new Uri(pattern), options => options
                .WithFramerate(fps)) 
            .OutputToPipe(new StreamPipeSink(async (stream, cancellationToken) => 
            {
                 uint frameIdx = 0;
                 while (await ReadExactAsync(stream, buffer, frameSize, token))
                 {
                      encoder.EncodeKeyframe(buffer, frameIdx * (uint)(1000/fps));
                      frameIdx++;
                 }
                 encoder.Finish();
            }), options => options
                .ForceFormat("rawvideo")
                .ForcePixelFormat("rgba"))
            .ProcessAsynchronously();
    }

    private async Task<bool> ReadExactAsync(Stream stream, byte[] buffer, int count, CancellationToken token)
    {
        int totalRead = 0;
        while (totalRead < count)
        {
            int read = await stream.ReadAsync(buffer, totalRead, count - totalRead, token);
            if (read == 0) return false; // End of stream
            totalRead += read;
        }
        return true;
    }
}
