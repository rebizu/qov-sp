using QovLibrary;

class Program
{
    static int Main(string[] args)
    {
        string outputFilename = "test_fix.qov";
        
        if (args.Length > 0)
        {
            outputFilename = args[0];
        }
        
        Console.WriteLine($"Creating DVD logo test video: {outputFilename}");
        
        int width = 640;
        int height = 480;
        int fps = 30;
        int durationSec = 5;
        int totalFrames = fps * durationSec;
        
        using var stream = File.Create(outputFilename);
        var encoder = new QovEncoder(stream, (ushort)width, (ushort)height, (ushort)fps, 1, QovTypes.FlagHasIndex, QovTypes.ColorspaceSrgb, true);

        // DVD logo bouncing parameters
        int logoX = 100, logoY = 100;
        int logoSize = 80;
        int velX = 3, velY = 2;
        
        // Color for DVD logo (red)
        byte colorR = 255, colorG = 0, colorB = 0;
        
        for (int frame = 0; frame < totalFrames; frame++)
        {
            uint timestamp = (uint)(frame * 1000000 / fps);
            
            // Clear frame to black background
            var pixels = new byte[width * height * 4];
            
            // Draw DVD logo
            for (int y = 0; y < logoSize; y++)
            {
                for (int x = 0; x < logoSize; x++)
                {
                    int drawY = logoY + y;
                    int drawX = logoX + x;
                    
                    if (drawY >= 0 && drawY < height && drawX >= 0 && drawX < width)
                    {
                        int offset = (drawY * width + drawX) * 4;
                        pixels[offset] = colorR;
                        pixels[offset + 1] = colorG;
                        pixels[offset + 2] = colorB;
                        pixels[offset + 3] = 255;
                    }
                }
            }
            
            // Update position
            logoX += velX;
            logoY += velY;
            
            // Bounce off edges
            if (logoX <= 0 || logoX + logoSize >= width)
            {
                velX = -velX;
                // Change color on bounce
                byte temp = colorR;
                colorR = colorB;
                colorB = temp;
                temp = colorG;
                colorG = colorR;
                colorR = temp;
            }
            if (logoY <= 0 || logoY + logoSize >= height)
            {
                velY = -velY;
                // Change color on bounce
                byte temp2 = colorR;
                colorR = colorG;
                colorG = colorB;
                colorB = temp2;
            }
            
            // Encode frame (keyframe every 30 frames)
            if (frame % 30 == 0)
            {
                Console.WriteLine($"Encoding keyframe {frame}/{totalFrames}");
                encoder.EncodeKeyframe(pixels, timestamp);
            }
            else
            {
                encoder.EncodePFrame(pixels, timestamp);
            }
        }

        encoder.Finish();
        
        Console.WriteLine($"Successfully encoded {totalFrames} frames to {outputFilename}");
        Console.WriteLine($"Duration: {durationSec} seconds at {fps} fps");
        Console.WriteLine($"File size: {stream.Length:N0} bytes");
        Console.WriteLine($"Average bitrate: {(stream.Length * 8.0 / durationSec / 1000):F2} kbps");

        return 0;
    }
}