using Xunit;
using QovLibrary;

namespace QovLibrary.Tests;

public class HeaderTests
{
    [Fact]
    public void Header_ValidMagic_CreatesCorrectHeader()
    {
        var header = new QovHeader(
            flags: QovTypes.FlagHasIndex,
            width: 1920,
            height: 1080,
            frameRateNum: 30,
            frameRateDen: 1,
            colorspace: QovTypes.ColorspaceSrgb
        );

        Assert.Equal(QovTypes.Magic, header.Magic);
        Assert.Equal(QovTypes.Version2, header.Version);
        Assert.Equal(QovTypes.FlagHasIndex, header.Flags);
        Assert.Equal((ushort)1920, header.Width);
        Assert.Equal((ushort)1080, header.Height);
        Assert.Equal((ushort)30, header.FrameRateNum);
        Assert.Equal((ushort)1, header.FrameRateDen);
        Assert.Equal(QovTypes.ColorspaceSrgb, header.Colorspace);
    }

    [Fact]
    public void GetChunkTypeName_ReturnsCorrectName()
    {
        Assert.Equal("SYNC", QovTypes.GetChunkTypeName(QovTypes.ChunkTypeSync));
        Assert.Equal("KEYFRAME", QovTypes.GetChunkTypeName(QovTypes.ChunkTypeKeyframe));
        Assert.Equal("PFRAME", QovTypes.GetChunkTypeName(QovTypes.ChunkTypePframe));
        Assert.Equal("BFRAME", QovTypes.GetChunkTypeName(QovTypes.ChunkTypeBframe));
        Assert.Equal("AUDIO", QovTypes.GetChunkTypeName(QovTypes.ChunkTypeAudio));
        Assert.Equal("INDEX", QovTypes.GetChunkTypeName(QovTypes.ChunkTypeIndex));
        Assert.Equal("END", QovTypes.GetChunkTypeName(QovTypes.ChunkTypeEnd));
        Assert.Equal("UNKNOWN(0xAB)", QovTypes.GetChunkTypeName(0xAB));
    }

    [Fact]
    public void QovPixel_Equality_WorksCorrectly()
    {
        var pixel1 = new QovPixel(255, 128, 64, 255);
        var pixel2 = new QovPixel(255, 128, 64, 255);
        var pixel3 = new QovPixel(255, 128, 64, 128);

        Assert.True(QovPixel.Equals(pixel1, pixel2));
        Assert.False(QovPixel.Equals(pixel1, pixel3));
    }

    [Fact]
    public void ColorCompression_FlagCorrect()
    {
        var header = new QovHeader(
            flags: QovTypes.FlagHasAlpha,
            width: 640,
            height: 480,
            colorspace: QovTypes.ColorspaceSrgba
        );

        Assert.Equal(QovTypes.FlagHasAlpha, header.Flags);
        Assert.Equal(QovTypes.ColorspaceSrgba, header.Colorspace);
    }
}