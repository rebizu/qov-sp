using Xunit;
using QovLibrary;

namespace QovLibrary.Tests;

public class DctRoundTripTests
{
    [Fact]
    public void Dct_EncodeDecodeRoundTrip_ReconstructsCloseToSource()
    {
        const int width = 32, height = 32;
        using var stream = new MemoryStream();

        // quality < 100 enables FlagLossyMode | FlagDctEnabled; YUV colorspace
        // selects the DCT P-frame path in EncodePFrame
        var encoder = new QovEncoder(stream, width, height, 30, 1, QovTypes.FlagHasIndex,
            QovTypes.ColorspaceYuv420, useCompression: true, quality: 50);

        byte[] keyPixels = CreateGradientPixels(width, height);
        encoder.EncodeKeyframe(keyPixels, 0);

        // A horizontally inverted gradient yields large mixed-sign DCT residuals,
        // which exercise multi-byte level encoding including negative values
        byte[] pPixels = InvertHorizontally(keyPixels, width, height);
        encoder.EncodePFrame(pPixels, 33333);
        encoder.Finish();

        var decoder = new QovDecoder(stream.ToArray());
        decoder.DecodeHeader();

        var frames = decoder.DecodeFrames().ToList();

        Assert.Equal(2, frames.Count);
        Assert.True(frames[0].IsKeyframe);

        // Before the big-endian/sign fixes, DCT levels decoded corrupted and
        // reconstruction drifted far from the source
        Assert.True(AverageAbsDiff(keyPixels, frames[0].Pixels) < 20,
            $"Keyframe reconstruction deviates by {AverageAbsDiff(keyPixels, frames[0].Pixels):F1} on average");
        Assert.True(AverageAbsDiff(pPixels, frames[1].Pixels) < 20,
            $"DCT P-frame reconstruction deviates by {AverageAbsDiff(pPixels, frames[1].Pixels):F1} on average");
    }

    private static byte[] CreateGradientPixels(int width, int height)
    {
        var pixels = new byte[width * height * 4];
        for (int y = 0; y < height; y++)
        {
            for (int x = 0; x < width; x++)
            {
                int i = (y * width + x) * 4;
                pixels[i] = (byte)(x * 255 / (width - 1));
                pixels[i + 1] = (byte)(y * 255 / (height - 1));
                pixels[i + 2] = (byte)((x + y) * 255 / (width + height - 2));
                pixels[i + 3] = 255;
            }
        }
        return pixels;
    }

    private static byte[] InvertHorizontally(byte[] pixels, int width, int height)
    {
        var inverted = new byte[pixels.Length];
        for (int y = 0; y < height; y++)
        {
            for (int x = 0; x < width; x++)
            {
                int src = (y * width + x) * 4;
                int dst = (y * width + (width - 1 - x)) * 4;
                inverted[dst] = pixels[src];
                inverted[dst + 1] = pixels[src + 1];
                inverted[dst + 2] = pixels[src + 2];
                inverted[dst + 3] = pixels[src + 3];
            }
        }
        return inverted;
    }

    private static double AverageAbsDiff(byte[] expected, byte[] actual)
    {
        int n = Math.Min(expected.Length, actual.Length) / 4;
        double total = 0;
        for (int p = 0; p < n; p++)
        {
            total += Math.Abs(expected[p * 4] - actual[p * 4]);
            total += Math.Abs(expected[p * 4 + 1] - actual[p * 4 + 1]);
            total += Math.Abs(expected[p * 4 + 2] - actual[p * 4 + 2]);
        }
        return total / (n * 3);
    }
}
