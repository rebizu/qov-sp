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

    [Fact]
    public void Structured_PF_RoundTrip_SmallerAndFaithful()
    {
        const int width = 64, height = 64;
        byte[] keyPixels = CreateGradientPixels(width, height);
        byte[] pPixels = InvertHorizontally(keyPixels, width, height);

        byte[] Encode(bool structured)
        {
            using var stream = new MemoryStream();
            var encoder = new QovEncoder(stream, width, height, 30, 1, QovTypes.FlagHasIndex,
                QovTypes.ColorspaceYuv420, useCompression: true, quality: 50,
                audioChannels: 0, audioRate: 0, rangeCoding: true, structuredPFrames: structured);
            encoder.EncodeKeyframe(keyPixels, 0);
            encoder.EncodePFrame(pPixels, 33333);
            encoder.Finish();
            return stream.ToArray();
        }

        byte[] v1 = Encode(false);
        byte[] v2 = Encode(true);

        // The structured chunk must carry the flag bit (bit 2 free of the
        // other P-frame flags: YUV 0x01, no motion here, DCT 0x20, range 0x08)
        bool hasFlag = false;
        int hdrLen = v2[4] == 3 ? 32 : 24; // lossy v3 files carry the 32-byte header
        for (int i = hdrLen; i + 10 <= v2.Length; )
        {
            byte type = v2[i], flags = v2[i + 1];
            uint size = (uint)((v2[i + 2] << 24) | (v2[i + 3] << 16) | (v2[i + 4] << 8) | v2[i + 5]);
            if (type == QovTypes.ChunkTypePframe)
            {
                hasFlag = (flags & QovTypes.ChunkFlagStructured) != 0;
                break;
            }
            i += 10 + (int)size;
        }
        Assert.True(hasFlag, "structured P-frame chunk is missing flag 0x04");
        Assert.True(v2.Length < v1.Length, "structured payload should be smaller");

        // Both grammars decode to the same pixels
        var d2 = new QovDecoder(v2);
        d2.DecodeHeader();
        var frames = d2.DecodeFrames().ToList();
        Assert.Equal(2, frames.Count);
        Assert.True(AverageAbsDiff(pPixels, frames[1].Pixels) < 20,
            $"structured reconstruction deviates by {AverageAbsDiff(pPixels, frames[1].Pixels):F1} on average");
    }

    [Fact]
    public void Structured_PF_SkipChain_Over255Blocks()
    {
        // A 256x256 static plane holds 1024 luma blocks; an all-skip P-frame
        // must terminate via the 255-continue chain (4x255 + 4) and decode
        // identically to the v1 grammar.
        const int width = 256, height = 256;
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, width, height, 30, 1, QovTypes.FlagHasIndex,
            QovTypes.ColorspaceYuv420, useCompression: true, quality: 50,
            audioChannels: 0, audioRate: 0, rangeCoding: true, structuredPFrames: true);
        byte[] keyPixels = CreateGradientPixels(width, height);
        encoder.EncodeKeyframe(keyPixels, 0);
        encoder.EncodePFrame(keyPixels, 33333); // identical frame: every block skips
        encoder.Finish();

        var decoder = new QovDecoder(stream.ToArray());
        decoder.DecodeHeader();
        var frames = decoder.DecodeFrames().ToList();
        Assert.Equal(2, frames.Count);
        // The all-skip P-frame must reconstruct exactly the keyframe's
        // (lossy) reconstruction — zero drift beyond the keyframe itself.
        Assert.True(AverageAbsDiff(frames[0].Pixels, frames[1].Pixels) < 0.001,
            $"all-skip structured P-frame drifts from the keyframe by {AverageAbsDiff(frames[0].Pixels, frames[1].Pixels):F3}");
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
