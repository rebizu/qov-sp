using System;
using FlashCap;

public class Program
{
    public static void Main()
    {
        Console.WriteLine("--- PixelFormats Enum ---");
        foreach (var name in Enum.GetNames(typeof(PixelFormats)))
        {
            var value = (int)Enum.Parse(typeof(PixelFormats), name);
            Console.WriteLine($"{name} = {value}");
        }
    }
}
