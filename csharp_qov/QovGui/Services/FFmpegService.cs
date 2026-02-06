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
using FlashCap;
using SkiaSharp;

namespace QovGui.Services;

public class FFmpegService : IFFmpegService
{
    public event Action<byte[]>? OnFrameCaptured;

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
            File.WriteAllText("ffmpeg_path_diag.txt", $"Path: '{path}'");
            return Task.FromResult(!string.IsNullOrEmpty(path));
        }
        catch
        {
            return Task.FromResult(false);
        }
    }

    public Task<List<string>> GetCamerasAsync()
    {
        var devices = new List<string>();
        try
        {
            var descriptors = new CaptureDevices().EnumerateDescriptors();
            foreach (var descriptor in descriptors)
            {
                devices.Add(descriptor.Name);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error listing cameras with FlashCap: {ex.Message}");
        }
        return Task.FromResult(devices.Distinct().ToList());
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

    public Task<List<ScreenInfo>> GetScreensAsync()
    {
        var result = new List<ScreenInfo>();
        if (Avalonia.Application.Current?.ApplicationLifetime is Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime desktop)
        {
            var screens = desktop.MainWindow?.Screens.All;
            if (screens != null)
            {
                int i = 1;
                foreach (var s in screens)
                {
                    result.Add(new ScreenInfo($"Screen {i} ({s.Bounds.Width}x{s.Bounds.Height})", s.Bounds.X, s.Bounds.Y, s.Bounds.Width, s.Bounds.Height));
                    i++;
                }
            }
        }
        
        if (result.Count == 0)
        {
            // Fallback for design time or if above fails
            result.Add(new ScreenInfo("Primary Screen", 0, 0, 1920, 1080));
        }
        
        return Task.FromResult(result);
    }

    public async Task StartRecordingAsync(string? videoDevice, string? audioDevice, QovLibrary.QovEncoder encoder, int width, int height, int fps, int keyframeInterval, CancellationToken token)
    {
        // Check if videoDevice is actually a screen selection
        int offsetX = 0;
        int offsetY = 0;
        bool isScreen = string.IsNullOrEmpty(videoDevice) || videoDevice == "Screen Capture" || videoDevice.StartsWith("Screen ");

        if (!isScreen)
        {
            await StartWebcamRecordingFlashCapAsync(videoDevice, encoder, width, height, fps, keyframeInterval, token);
            return;
        }

        if (isScreen && videoDevice?.StartsWith("Screen ") == true)
        {
             // Try to find the screen info
             var screens = await GetScreensAsync();
             var screen = screens.FirstOrDefault(s => s.Name == videoDevice);
             if (screen != null)
             {
                 offsetX = screen.X;
                 offsetY = screen.Y;
             }
        }

        // 1. Build FFmpeg command line
        string ffmpegPath = GlobalFFOptions.GetFFMpegBinaryPath();
        
        // Ensure we have the full path if possible
        if (string.IsNullOrEmpty(ffmpegPath))
        {
            ffmpegPath = OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";
        }

        string inputArgs;
        if (isScreen)
        {
            if (OperatingSystem.IsWindows())
            {
                inputArgs = $"-f gdigrab -framerate {fps} -offset_x {offsetX} -offset_y {offsetY} -i desktop";
            }
            else if (OperatingSystem.IsLinux())
            {
                inputArgs = $"-f x11grab -framerate {fps} -i :0.0+{offsetX},{offsetY}";
            }
            else if (OperatingSystem.IsMacOS())
            {
                inputArgs = $"-f avfoundation -framerate {fps} -i \"1\"";
            }
            else
            {
                throw new PlatformNotSupportedException("Screen capture not implemented for this platform.");
            }
        }
        else
        {
            // Fallback (should not be reached if !isScreen and started above)
            if (OperatingSystem.IsWindows())
                inputArgs = $"-f dshow -video_size {width}x{height} -framerate {fps} -i \"video={videoDevice}";
            else if (OperatingSystem.IsLinux())
                inputArgs = $"-f v4l2 -video_size {width}x{height} -framerate {fps} -i \"{videoDevice}";
            else
                inputArgs = $"-f avfoundation -video_size {width}x{height} -framerate {fps} -i \"{videoDevice}";
                
            if (!string.IsNullOrEmpty(audioDevice))
            {
                if (OperatingSystem.IsWindows())
                    inputArgs += $":audio={audioDevice}";
            }
            inputArgs += "\"";
        }

        string outputArgs = $"-vf scale={width}:{height} -f rawvideo -pix_fmt rgba -";

        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                Arguments = $"{inputArgs} {outputArgs}",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        // 2. Start process and encoding loop
        process.Start();
        var sw = Stopwatch.StartNew();

        try 
        {
            using var stdout = process.StandardOutput.BaseStream;
            int frameSize = width * height * 4;
            byte[] buffer = new byte[frameSize];
            uint frameIdx = 0;

            while (!token.IsCancellationRequested)
            {
                if (!await ReadExactAsync(stdout, buffer, frameSize, token))
                    break;

                bool isKeyframe = (frameIdx % (uint)keyframeInterval) == 0;
                uint timestampUs = (uint)(sw.Elapsed.TotalMicroseconds);

                if (isKeyframe)
                {
                    encoder.EncodeKeyframe(buffer, timestampUs);
                }
                else
                {
                    encoder.EncodePFrame(buffer, timestampUs);
                }
                
                // Trigger preview
                OnFrameCaptured?.Invoke(buffer);
                
                frameIdx++;
            }
            
            encoder.Finish();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Recording loop error: {ex.Message}");
            throw;
        }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(); } catch { }
            }
            await process.WaitForExitAsync();
            
            if (process.ExitCode != 0)
            {
                string error = await process.StandardError.ReadToEndAsync();
                Console.WriteLine($"FFmpeg Exit Code {process.ExitCode}: {error}");
                throw new Exception($"FFmpeg failed with exit code {process.ExitCode}: {error}");
            }
        }
    }
    
    private async Task StartWebcamRecordingFlashCapAsync(string? deviceName, QovLibrary.QovEncoder encoder, int width, int height, int fps, int keyframeInterval, CancellationToken token)
    {
        var devices = new CaptureDevices();
        var descriptor = devices.EnumerateDescriptors().FirstOrDefault(d => d.Name == deviceName);
        if (descriptor == null) throw new Exception($"Camera device '{deviceName}' not found.");

        // Find best match for characteristics
        var characteristics = descriptor.Characteristics
            .OrderByDescending(c => c.Width == width && c.Height == height)
            .ThenBy(c => Math.Abs((double)c.FramesPerSecond - fps))
            .FirstOrDefault();

        if (characteristics == null) 
        {
            Console.WriteLine("No suitable camera characteristics found.");
            throw new Exception("No suitable camera characteristics found.");
        }

        Console.WriteLine($"Selected Camera Characteristic: {characteristics.Width}x{characteristics.Height} @ {characteristics.FramesPerSecond} ({characteristics.PixelFormat})");

        uint frameIdx = 0;
        var sw = Stopwatch.StartNew();
        var semaphore = new SemaphoreSlim(1, 1);

        using var device = await descriptor.OpenAsync(characteristics, TranscodeFormats.DoNotTranscode, async scope =>
        {
            await semaphore.WaitAsync();
            try
            {
                // With DoNotTranscode, raw buffer contains actual YUYV/NV12/etc data
                byte[] raw = scope.Buffer.ExtractImage();
                if (raw == null || raw.Length == 0) return;
                
                // Raw YUV is almost always top-down. RGB DIBs are bottom-up.
                bool isYuv = characteristics.PixelFormat == PixelFormats.YUYV || 
                             characteristics.PixelFormat == PixelFormats.UYVY ||
                             characteristics.PixelFormat.ToString() == "YUY2" ||
                             characteristics.PixelFormat.ToString() == "NV12";
                
                bool flip = !isYuv; // Flip RGB but not YUV

                byte[] rgba = ConvertToRgba(raw, characteristics.Width, characteristics.Height, characteristics.PixelFormat, flip);

                if (rgba == null || rgba.Length == 0) return;

                // Scale if necessary
                if (characteristics.Width != width || characteristics.Height != height)
                {
                    rgba = ScaleRgba(rgba, characteristics.Width, characteristics.Height, width, height);
                }

                bool isKeyframe = (frameIdx % (uint)keyframeInterval) == 0;
                uint timestampUs = (uint)(sw.Elapsed.TotalMicroseconds);

                if (isKeyframe) encoder.EncodeKeyframe(rgba, timestampUs);
                else encoder.EncodePFrame(rgba, timestampUs);

                OnFrameCaptured?.Invoke(rgba);
                frameIdx++;
            }
            catch (Exception ex)
            {
                if (frameIdx % 100 == 0) Console.WriteLine($"FlashCap capture error: {ex.Message}");
            }
            finally
            {
                semaphore.Release();
            }
        });

        await device.StartAsync();

        try
        {
            // Wait until cancelled
            await Task.Delay(-1, token);
        }
        catch (OperationCanceledException)
        {
            // Normal stop
        }
        finally
        {
            await device.StopAsync();
            encoder.Finish();
        }
    }

    private byte[] ConvertToRgba(byte[] data, int width, int height, PixelFormats format, bool flipVertical)
    {
        int pixelCount = width * height;
        byte[] rgba = new byte[pixelCount * 4];

        if (format == PixelFormats.RGB24)
        {
            int stride = (width * 3 + 3) & ~3;
            for (int y = 0; y < height; y++)
            {
                int srcY = flipVertical ? (height - 1 - y) : y;
                int srcRow = srcY * stride;
                int dstRow = y * width * 4;
                for (int x = 0; x < width; x++)
                {
                    int si = srcRow + x * 3;
                    int di = dstRow + x * 4;
                    if (si + 2 < data.Length)
                    {
                        rgba[di + 0] = data[si + 2]; // R
                        rgba[di + 1] = data[si + 1]; // G
                        rgba[di + 2] = data[si + 0]; // B
                        rgba[di + 3] = 255;
                    }
                }
            }
            return rgba;
        }
        else if (format == PixelFormats.RGB32 || format == PixelFormats.ARGB32)
        {
             int stride = width * 4;
             for (int y = 0; y < height; y++)
             {
                int srcY = flipVertical ? (height - 1 - y) : y;
                int srcRow = srcY * stride;
                int dstRow = y * width * 4;
                for (int x = 0; x < width; x++)
                {
                    int si = srcRow + x * 4;
                    int di = dstRow + x * 4;
                    if (si + 3 < data.Length)
                    {
                        rgba[di + 0] = data[si + 2]; // R
                        rgba[di + 1] = data[si + 1]; // G
                        rgba[di + 2] = data[si + 0]; // B
                        rgba[di + 3] = data[si + 3]; // A
                    }
                }
             }
             return rgba;
        }
        else if (format == PixelFormats.YUYV || format.ToString() == "YUY2")
        {
            return ConvertYuyvToRgba(data, width, height, flipVertical);
        }
        else if (format == PixelFormats.UYVY)
        {
            return ConvertUyvyToRgba(data, width, height, flipVertical);
        }
        else if (format.ToString() == "NV12")
        {
            return ConvertNv12ToRgba(data, width, height, flipVertical);
        }
        else if (format == PixelFormats.JPEG || format == PixelFormats.PNG)
        {
            byte[] decompressed = ConvertCompressedToRgba(data, width, height);
            if (flipVertical)
            {
                return FlipVertical(decompressed, width, height);
            }
            return decompressed;
        }
        else 
        {
            if (data.Length == pixelCount * 4) return data;
            return new byte[pixelCount * 4];
        }
    }

    private byte[] FlipVertical(byte[] data, int width, int height)
    {
        byte[] flipped = new byte[data.Length];
        int stride = width * 4;
        for (int y = 0; y < height; y++)
        {
            Array.Copy(data, y * stride, flipped, (height - 1 - y) * stride, stride);
        }
        return flipped;
    }

    private byte[] ScaleRgba(byte[] data, int srcW, int srcH, int dstW, int dstH)
    {
        try
        {
            using var dstBitmap = new SKBitmap(dstW, dstH);
            var info = new SKImageInfo(srcW, srcH, SKColorType.Rgba8888, SKAlphaType.Premul);
            
            using var srcBitmap = new SKBitmap();
            unsafe {
                fixed (byte* pData = data) {
                    srcBitmap.InstallPixels(info, (IntPtr)pData);
                    if (srcBitmap.ScalePixels(dstBitmap, SKSamplingOptions.Default))
                    {
                        return dstBitmap.Bytes;
                    }
                }
            }
            return new byte[dstW * dstH * 4];
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Scaling failed: {ex.Message}");
            return new byte[dstW * dstH * 4];
        }
    }

    private unsafe byte[] ConvertYuyvToRgba(byte[] data, int width, int height, bool flipVertical)
    {
        int pixelCount = width * height;
        byte[] rgba = new byte[pixelCount * 4];
        int stride = data.Length / height;

        fixed (byte* pData = data, pRgba = rgba)
        {
            for (int y = 0; y < height; y++)
            {
                int srcY = flipVertical ? (height - 1 - y) : y;
                byte* src = pData + srcY * stride;
                byte* dst = pRgba + y * width * 4;
                
                for (int x = 0; x < width / 2; x++)
                {
                    if ((x * 4 + 3) >= stride) break;

                    byte y0 = src[x * 4 + 0];
                    byte v  = src[x * 4 + 1]; // Swapped for this specific hardware
                    byte y1 = src[x * 4 + 2];
                    byte u  = src[x * 4 + 3]; // Swapped for this specific hardware

                    int du = u - 128;
                    int dv = v - 128;

                    // Full Range BT.601 (JPEG)
                    dst[x * 8 + 0] = (byte)Math.Clamp(y0 + 1.402 * dv, 0, 255); // R
                    dst[x * 8 + 1] = (byte)Math.Clamp(y0 - 0.344136 * du - 0.714136 * dv, 0, 255); // G
                    dst[x * 8 + 2] = (byte)Math.Clamp(y0 + 1.772 * du, 0, 255); // B
                    dst[x * 8 + 3] = 255;

                    dst[x * 8 + 4] = (byte)Math.Clamp(y1 + 1.402 * dv, 0, 255); // R
                    dst[x * 8 + 5] = (byte)Math.Clamp(y1 - 0.344136 * du - 0.714136 * dv, 0, 255); // G
                    dst[x * 8 + 6] = (byte)Math.Clamp(y1 + 1.772 * du, 0, 255); // B
                    dst[x * 8 + 7] = 255;
                }
            }
        }
        return rgba;
    }

    private unsafe byte[] ConvertUyvyToRgba(byte[] data, int width, int height, bool flipVertical)
    {
        int pixelCount = width * height;
        byte[] rgba = new byte[pixelCount * 4];
        int stride = data.Length / height;

        fixed (byte* pData = data, pRgba = rgba)
        {
            for (int y = 0; y < height; y++)
            {
                int srcY = flipVertical ? (height - 1 - y) : y;
                byte* src = pData + srcY * stride;
                byte* dst = pRgba + y * width * 4;

                for (int x = 0; x < width / 2; x++)
                {
                    if ((x * 4 + 3) >= stride) break;

                    byte v  = src[x * 4 + 0]; // Swapped
                    byte y0 = src[x * 4 + 1];
                    byte u  = src[x * 4 + 2]; // Swapped
                    byte y1 = src[x * 4 + 3];

                    int du = u - 128;
                    int dv = v - 128;

                    dst[x * 8 + 0] = (byte)Math.Clamp(y0 + 1.402 * dv, 0, 255);
                    dst[x * 8 + 1] = (byte)Math.Clamp(y0 - 0.344136 * du - 0.714136 * dv, 0, 255);
                    dst[x * 8 + 2] = (byte)Math.Clamp(y0 + 1.772 * du, 0, 255);
                    dst[x * 8 + 3] = 255;

                    dst[x * 8 + 4] = (byte)Math.Clamp(y1 + 1.402 * dv, 0, 255);
                    dst[x * 8 + 5] = (byte)Math.Clamp(y1 - 0.344136 * du - 0.714136 * dv, 0, 255);
                    dst[x * 8 + 6] = (byte)Math.Clamp(y1 + 1.772 * du, 0, 255);
                    dst[x * 8 + 7] = 255;
                }
            }
        }
        return rgba;
    }

    private unsafe byte[] ConvertNv12ToRgba(byte[] data, int width, int height, bool flipVertical)
    {
        int pixelCount = width * height;
        byte[] rgba = new byte[pixelCount * 4];
        int yStride = width; 
        int uvStride = width; 

        fixed (byte* pData = data, pRgba = rgba)
        {
            byte* yPtr = pData;
            byte* uvPtr = pData + pixelCount;

            for (int y = 0; y < height; y++)
            {
                int srcY = flipVertical ? (height - 1 - y) : y;
                byte* dstRow = pRgba + y * width * 4;
                byte* srcYRow = yPtr + srcY * yStride;
                byte* srcUvRow = uvPtr + (srcY / 2) * uvStride;

                for (int x = 0; x < width; x++)
                {
                    byte yVal = srcYRow[x];
                    int uvCol = (x / 2) * 2;
                    
                    byte v = srcUvRow[uvCol];     // Swapped for NV21/Non-standard NV12
                    byte u = srcUvRow[uvCol + 1]; // Swapped for NV21/Non-standard NV12

                    int du = u - 128;
                    int dv = v - 128;

                    dstRow[x * 4 + 0] = (byte)Math.Clamp(yVal + 1.402 * dv, 0, 255);
                    dstRow[x * 4 + 1] = (byte)Math.Clamp(yVal - 0.344136 * du - 0.714136 * dv, 0, 255);
                    dstRow[x * 4 + 2] = (byte)Math.Clamp(yVal + 1.772 * du, 0, 255);
                    dstRow[x * 4 + 3] = 255;
                }
            }
        }
        return rgba;
    }

    private unsafe byte[] ConvertCompressedToRgba(byte[] data, int width, int height)
    {
        try
        {
            using var codec = SKCodec.Create(new MemoryStream(data));
            if (codec == null) return new byte[width * height * 4];

            var info = new SKImageInfo(width, height, SKColorType.Rgba8888);
            byte[] rgba = new byte[width * height * 4];
            fixed (byte* pRgba = rgba)
            {
                codec.GetPixels(info, (IntPtr)pRgba);
            }
            return rgba;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"FlashCap: MJPEG decompression failed: {ex.Message}");
            return new byte[width * height * 4];
        }
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
         File.WriteAllText("device_discovery_raw.txt", output);
         return output;
    }

     private List<string> ParseFFmpegDevices(string output, string type)
    {
         var list = new List<string>();
         var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
         
         foreach (var line in lines)
         {
             // Look for specific hardware type indicator
             bool isMatch = line.IndexOf($"({type})", StringComparison.OrdinalIgnoreCase) >= 0;
             
             if (isMatch)
             {
                  // Extract name between quotes
                  var match = Regex.Match(line, "\"([^\"]*)\"");
                  if (match.Success)
                  {
                      string name = match.Groups[1].Value;
                      // Avoid "Alternative name" entries
                      if (!line.Contains("Alternative name"))
                      {
                         list.Add(name);
                      }
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
