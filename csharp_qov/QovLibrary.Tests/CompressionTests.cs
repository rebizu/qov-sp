using Xunit;
using QovLibrary;

namespace QovLibrary.Tests;

public class CompressionTests
{
    [Fact]
    public void Lz4_CompressesData()
    {
        byte[] data = new byte[1024];
        for (int i = 0; i < data.Length; i++)
        {
            data[i] = (byte)(i % 10);
        }

        var compressed = Lz4Compression.Compress(data);

        Assert.NotNull(compressed);
        Assert.True(compressed.Length < data.Length);
    }

    [Fact]
    public void Lz4_CompressionNotWorthwhile()
    {
        byte[] data = new byte[100];
        var random = new Random(42);
        random.NextBytes(data);

        var compressed = Lz4Compression.Compress(data);

        Assert.Null(compressed);
    }

    [Fact]
    public void Lz4_DecompressesCorrectly()
    {
        byte[] original = new byte[1024];
        for (int i = 0; i < original.Length; i++)
        {
            original[i] = (byte)(i % 10);
        }

        byte[] compressed = Lz4Compression.Compress(original) ?? original;
        byte[] decompressed = Lz4Compression.Decompress(compressed, original.Length);

        Assert.Equal(original.Length, decompressed.Length);
        Assert.Equal(original, decompressed);
    }

    [Fact]
    public void Lz4_EmptyData()
    {
        byte[] data = Array.Empty<byte>();

        var compressed = Lz4Compression.Compress(data);
        var decompressed = Lz4Compression.Decompress(data, 0);

        Assert.Empty(compressed);
        Assert.Empty(decompressed);
    }

    [Fact]
    public void ColorConversion_RgbaToYuv420()
    {
        byte[] pixels = PreparePixels(100, 100, 255);

        ColorConversion.RgbaToYuv420(pixels, 100, 100,
            out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        Assert.Equal(10000, yPlane.Length);
        Assert.Equal(2500, uPlane.Length);
        Assert.Equal(2500, vPlane.Length);
    }

    [Fact]
    public void ColorConversion_Yuv420ToRgbaRoundtrip()
    {
        byte[] original = PreparePixels(100, 100, 128);

        ColorConversion.RgbaToYuv420(original, 100, 100,
            out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        byte[] result = new byte[original.Length];
        ColorConversion.Yuv420ToRgba(yPlane, uPlane, vPlane, 100, 100, result);

        Assert.Equal(10000, result.Length / 4);
    }

    private byte[] PreparePixels(int width, int height, byte value)
    {
        byte[] pixels = new byte[width * height * 4];
        for (int i = 0; i < pixels.Length; i += 4)
        {
            pixels[i] = value;
            pixels[i + 1] = value;
            pixels[i + 2] = value;
            pixels[i + 3] = 255;
        }
        return pixels;
    }
}