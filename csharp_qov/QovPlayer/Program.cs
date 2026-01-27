using QovLibrary;

class Program
{
    static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.WriteLine("QOV Player");
            Console.WriteLine("Usage: QovPlayer <qov-file> [--info]");
            return 1;
        }

        string filepath = args[0];
        bool infoOnly = args.Length > 1 && args[1] == "--info";

        using var stream = File.OpenRead(filepath);
        var decoder = new QovDecoder(stream);

        try
        {
            var header = decoder.DecodeHeader();
            Console.WriteLine($"QOV File: {Path.GetFileName(filepath)}");
            Console.WriteLine($"  Resolution: {header.Width}x{header.Height}");
            Console.WriteLine($"  Frame Rate: {header.FrameRateNum}/{header.FrameRateDen} Hz");
            Console.WriteLine($"  Total Frames: {header.TotalFrames}");

            if (!infoOnly)
            {
                Console.WriteLine("Playing...");
                foreach (var frame in decoder.DecodeFrames())
                {
                    Console.Write($"\rFrame {frame.FrameNumber + 1} | Type: {(frame.IsKeyframe ? "KEY" : "P")}   ");
                }
                Console.WriteLine("\nDone.");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error: {ex.Message}");
            return 1;
        }

        return 0;
    }
}
