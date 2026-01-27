using Microsoft.Extensions.Hosting;
using QovLibrary;

namespace StreamingDecoder;

class Program
{
    static async Task Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.WriteLine("Usage: StreamingDecoder <qov-file>");
            Console.WriteLine("Example: StreamingDecoder video.qov");
            return;
        }

        string filepath = args[0];
        if (!File.Exists(filepath))
        {
            Console.WriteLine($"Error: File not found: {filepath}");
            return;
        }

        Console.WriteLine($"Streaming QOV file: {filepath}");
        Console.WriteLine("Press Ctrl+C to exit");

        using var host = CreateHostBuilder(filepath).Build();
        await host.RunAsync();
    }

    static IHostBuilder CreateHostBuilder(string filepath) =>
        Host.CreateDefaultBuilder()
            .UseConsoleLifetime()
            .ConfigureServices((context, services) =>
            {
                services.AddHostedService(sp => new StreamingWorker(filepath));
            });
}

public class StreamingWorker : BackgroundService
{
    private readonly string _filepath;

    public StreamingWorker(string filepath)
    {
        _filepath = filepath;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var stream = File.OpenRead(_filepath);
        var decoder = new QovDecoder(stream);

        try
        {
            var header = decoder.DecodeHeader();
            Console.WriteLine($"Header Info:");
            Console.WriteLine($"  Resolution: {header.Width}x{header.Height}");
            Console.WriteLine($"  Frame Rate: {header.FrameRateNum}/{header.FrameRateDen} Hz");
            Console.WriteLine($"  Colorspace: {header.Colorspace:X2}");

            int frameCount = 0;
            foreach (var frame in decoder.DecodeFrames())
            {
                if (stoppingToken.IsCancellationRequested)
                    break;

                frameCount++;

                if (frameCount % 30 == 0)
                {
                    Console.WriteLine($"Decoded frame {frameCount}: {(frame.IsKeyframe ? "KEY" : "P")} @ {frame.Timestamp} us");
                }
            }

            Console.WriteLine($"Total frames decoded: {frameCount}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }
}