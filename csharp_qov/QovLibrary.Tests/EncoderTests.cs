using Xunit;
using QovLibrary;

namespace QovLibrary.Tests;

public class EncoderTests
{
    [Fact]
    public void Encoder_CreatesValidHeader()
    {
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, 640, 480, 30, 1, QovTypes.FlagHasIndex, QovTypes.ColorspaceSrgb);

        encoder.Finish();

        stream.Position = 0;
        var data = stream.ToArray();
        Assert.Equal(0x71, data[0]);
        Assert.Equal(0x6F, data[1]);
        Assert.Equal(0x76, data[2]);
        Assert.Equal(0x66, data[3]);
        Assert.Equal(QovTypes.Version2, data[4]);
    }

    [Fact]
    public void Encoder_EncodesKeyframe()
    {
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, 4, 4);

        var pixels = CreateTestPixels(4, 4, 255);
        encoder.EncodeKeyframe(pixels, 0);

        Assert.Equal(0, encoder.FrameCount - 1);
        Assert.True(stream.Length > 24);
    }

    [Fact]
    public void Encoder_EncodesPFrame()
    {
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, 4, 4);

        var pixels1 = CreateTestPixels(4, 4, 255);
        encoder.EncodeKeyframe(pixels1, 0);

        var pixels2 = CreateTestPixels(4, 4, 200);
        encoder.EncodePFrame(pixels2, 33333);

        Assert.Equal(2, encoder.FrameCount);
    }

    [Fact]
    public void Encoder_WritesIndexTable()
    {
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, 4, 4, 30, 1, QovTypes.FlagHasIndex);

        var pixels = CreateTestPixels(4, 4, 255);
        encoder.EncodeKeyframe(pixels, 0);
        encoder.Finish();

        stream.Position = 0;
        var data = stream.ToArray();
        Assert.Contains(data, b => b == QovTypes.ChunkTypeIndex);
    }

    [Fact]
    public void Encoder_WritesEndMarker()
    {
        using var stream = new MemoryStream();
        var encoder = new QovEncoder(stream, 4, 4);

        encoder.EncodeKeyframe(CreateTestPixels(4, 4, 255), 0);
        encoder.Finish();

        stream.Position = 0;
        var data = stream.ToArray();

        Assert.True(data.Length > 24);
        Assert.Contains(data.Skip(data.Length - 20), b => b == QovTypes.ChunkTypeEnd);
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