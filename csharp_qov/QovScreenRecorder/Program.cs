using QovLibrary;

namespace QovScreenRecorder;

class Program
{
    static async Task<int> Main(string[] args)
    {
        Console.WriteLine("QOV Screen Recorder");
        Console.WriteLine("Usage: QovScreenRecorder <output.qov> [--width W] [--height H] [--fps N]");

        if (args.Length < 1)
        {
            Console.WriteLine("Error: output file required");
            return 1;
        }

        string filename = args[0];
        ushort width = 1920;
        ushort height = 1080;
        int fps = 30;
        byte colorspace = QovTypes.ColorspaceSrgb;

        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--width" && i + 1 < args.Length)
                width = ushort.Parse(args[i + 1]);
            else if (args[i] == "--height" && i + 1 < args.Length)
                height = ushort.Parse(args[i + 1]);
            else if (args[i] == "--fps" && i + 1 < args.Length)
                fps = int.Parse(args[i + 1]);
            else if (args[i] == "--colorspace" && i + 1 < args.Length && args[i + 1] == "yuv420")
                colorspace = QovTypes.ColorspaceYuv420;
        }

        Console.WriteLine($"Recording {width}x{height} @ {fps}fps to {filename}");
        
        using var stream = File.Create(filename);
        var encoder = new QovEncoder(stream, width, height, (ushort)fps, 1, 0, colorspace);

        for (int i = 0; i < 300; i++)
        {
            var pixels = new byte[width * height * 4];
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    int idx = (y * width + x) * 4;
                    pixels[idx] = (byte)((x + y + i) % 256);
                    pixels[idx + 1] = (byte)(y % 256);
                    pixels[idx + 2] = 128;
                    pixels[idx + 3] = 255;
                }
            }

            uint timestamp = (uint)(i * 1000000 / fps);

            if (i % 30 == 0)
                encoder.EncodeKeyframe(pixels, timestamp);
            else
                encoder.EncodePFrame(pixels, timestamp);

            Console.Write($"Recording: {i + 1}/300\r");
        }

        encoder.Finish();
        Console.WriteLine($"\nComplete! {stream.Length:N0} bytes");

        return 0;
    }
}