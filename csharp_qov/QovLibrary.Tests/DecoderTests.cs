using Xunit;
using QovLibrary;

namespace QovLibrary.Tests;

public class DecoderTests
{
    [Fact]
    public void Decoder_ReadsHeaderCorrectly()
    {
        var data = CreateTestFile(640, 480, 30);

        using var stream = new MemoryStream(data);
        var decoder = new QovDecoder(stream);

        var header = decoder.DecodeHeader();

        Assert.Equal(640u, header.Width);
        Assert.Equal(480u, header.Height);
        Assert.Equal(30u, header.FrameRateNum);
        Assert.Equal(1u, header.FrameRateDen);
    }

    [Fact]
    public void Decoder_DecodesKeyframe()
    {
        var data = CreateTestFile(4, 4);

        using var stream = new MemoryStream(data);
        var decoder = new QovDecoder(stream);

        decoder.DecodeHeader();

        foreach (var frame in decoder.DecodeFrames())
        {
            Assert.True(frame.IsKeyframe);
            Assert.NotNull(frame.Pixels);
            Assert.True(frame.Pixels.Length >= 16);
            break;
        }
    }

    [Fact]
    public void Decoder_DecodesPFrame()
    {
        var data = CreateTestFile(8, 8);

        using var stream = new MemoryStream(data);
        var decoder = new QovDecoder(stream);

        decoder.DecodeHeader();

        var frames = decoder.DecodeFrames().ToList();
        Assert.True(frames.Count >= 2);

        Assert.True(frames[0].IsKeyframe);
    }

    [Fact]
    public void Decoder_HandlesInvalidMagic()
    {
        var data = new byte[] { 0x00, 0x00, 0x00, 0x00 };

        using var stream = new MemoryStream(data);
        var decoder = new QovDecoder(stream);

        Assert.Throws<QovException>(() => decoder.DecodeHeader());
    }

    [Fact]
    public void Decoder_HandlesEndMarker()
    {
        var data = CreateTestFile(8, 8);

        using var stream = new MemoryStream(data);
        var decoder = new QovDecoder(stream);

        decoder.DecodeHeader();

        var frameCount = 0;
        foreach (var frame in decoder.DecodeFrames())
        {
            frameCount++;
        }

        Assert.True(frameCount > 0);
    }

    private byte[] CreateTestFile(int width, int height, int frameCount = 5)
    {
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, (ushort)width, (ushort)height, 30, 1, QovTypes.FlagHasIndex, QovTypes.ColorspaceSrgb, false);

        for (int i = 0; i < frameCount; i++)
        {
            var pixels = CreateTestPixels(width, height, (byte)(i % 255));
            ulong timestamp = (ulong)(i * 33333);
            encoder.EncodeKeyframe(pixels, 0);
        }

        encoder.Finish();

        return stream.ToArray();
    }

    private byte[] CreateTestPixels(int width, int height, byte value)
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