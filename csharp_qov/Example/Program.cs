using SkiaSharp;
using QovLibrary;

namespace Example;

class Example
{
    static void Main(string[] args)
    {
        Console.WriteLine("QOV Library Example");
        Console.WriteLine("=====================");
        Console.WriteLine();

        string outputFile = "example.qov";
        ushort width = 640;
        ushort height = 480;
        int fps = 30;
        int frames = 90;

        Console.WriteLine($"Creating demonstration video:");
        Console.WriteLine($"  Resolution: {width}x{height}");
        Console.WriteLine($"  Frame rate: {fps} fps");
        Console.WriteLine($"  Duration: {frames} frames ({frames/fps}s)");
        Console.WriteLine();

        using var stream = File.Create(outputFile);
        var encoder = new QovEncoder(stream, width, height, (ushort)fps, 1, QovTypes.FlagHasIndex, QovTypes.ColorspaceSrgb);

        for (int i = 0; i < frames; i++)
        {
            var pixels = CreateTestPattern(width, height, i, frames);
            ulong timestamp = (ulong)(i * 1000000 / fps);

            if (i % 30 == 0)
            {
                encoder.EncodeKeyframe(pixels, (uint)timestamp);
                Console.WriteLine($"  Keyframe {i + 1}/{frames}");
            }
            else
            {
                encoder.EncodePFrame(pixels, (uint)timestamp);
            }

            if (i % 10 == 0)
            {
                Console.Write($"  Encoding: {i + 1}/{frames}\r");
            }
        }

        encoder.Finish();
        Console.WriteLine($"\n  Done! File saved to {outputFile}");
        Console.WriteLine($"  File size: {stream.Length:N0} bytes");
        Console.WriteLine();

        Console.WriteLine("Decoding and playing back...");
        Console.WriteLine();

        stream.Position = 0;
        var decoder = new QovDecoder(stream);

        var header = decoder.DecodeHeader();
        Console.WriteLine($"  Confirmed: {header.Width}x{header.Height}, {header.FrameRateNum}/{header.FrameRateDen} fps");
        Console.WriteLine();

        int frameNum = 0;
        int keyframeCount = 0;

        foreach (var frame in decoder.DecodeFrames())
        {
            frameNum++;

            if (frame.IsKeyframe)
            {
                keyframeCount++;
                Console.WriteLine($"  Frame {frameNum}: Keyframe @ {frame.Timestamp} us");
            }
            else if (frameNum % 30 == 0)
            {
                Console.WriteLine($"  Frame {frameNum}: P-frame @ {frame.Timestamp} us");
            }
        }

        Console.WriteLine($"  Total frames: {frameNum} ({keyframeCount} keyframes)");
        Console.WriteLine();
        Console.WriteLine("Example completed successfully!");
    }

    static byte[] CreateTestPattern(ushort width, ushort height, int frameNumber, int totalFrames)
    {
        byte[] pixels = new byte[width * height * 4];
        double progress = (double)frameNumber / totalFrames * 2 * Math.PI;

        for (int y = 0; y < height; y++)
        {
            for (int x = 0; x < width; x++)
            {
                int idx = (y * width + x) * 4;

                double dx = (double)x / width - 0.5;
                double dy = (double)y / height - 0.5;
                double dist = Math.Sqrt(dx * dx + dy * dy);

                byte red = (byte)(128 + 127 * Math.Sin(Math.PI * 2 * dist + progress));
                byte green = (byte)(128 + 127 * Math.Sin(Math.PI * 2 + progress));
                byte blue = (byte)(128 + 127 * Math.Cos(Math.PI * 2 * dist + progress));

                pixels[idx] = red;
                pixels[idx + 1] = green;
                pixels[idx + 2] = blue;
                pixels[idx + 3] = 255;
            }
        }

        return pixels;
    }
}