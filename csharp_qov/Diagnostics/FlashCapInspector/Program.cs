using System;
using System.Linq;
using FlashCap;

public class Program
{
    public static void Main()
    {
        Console.WriteLine("QOV Webcam Diagnostic Tool");
        Console.WriteLine("=========================");
        
        var devices = new CaptureDevices();
        var descriptors = devices.EnumerateDescriptors().ToArray();
        
        if (descriptors.Length == 0)
        {
            Console.WriteLine("No camera devices detected.");
            return;
        }

        foreach (var descriptor in descriptors)
        {
            Console.WriteLine($"\nDevice: {descriptor.Name}");
            Console.WriteLine($"Identity: {descriptor.Identity}");
            Console.WriteLine("Characteristics:");
            
            foreach (var chara in descriptor.Characteristics.OrderByDescending(c => c.Width).ThenByDescending(c => (double)c.FramesPerSecond))
            {
                Console.WriteLine($"  - {chara.Width}x{chara.Height} @ {chara.FramesPerSecond} ({chara.PixelFormat})");
            }
        }
    }
}
