using Xunit;
using QovLibrary.Streaming;

namespace QovLibrary.Tests;

public class QovPacketHeaderTests
{
    [Fact]
    public void Header_RoundTripsAllFields()
    {
        var header = new QovPacketHeader
        {
            Magic = QovPacketHeader.MagicValue,
            Version = QovPacketHeader.VersionValue,
            PacketType = QovPacketType.Fec,
            Seq = 0xDEADBEEF,
            FrameId = 123456,
            FragmentId = 7,
            FragmentCount = 12,
            PayloadSize = 1180
        };
        var buf = new byte[QovPacketHeader.Size + 4];
        header.WriteTo(buf);
        var parsed = QovPacketHeader.Parse(buf);

        Assert.Equal(QovPacketHeader.MagicValue, parsed.Magic);
        Assert.Equal((byte)0x02, parsed.Version);
        Assert.Equal(QovPacketType.Fec, parsed.PacketType);
        Assert.Equal(0xDEADBEEFu, parsed.Seq);
        Assert.Equal(123456u, parsed.FrameId);
        Assert.Equal((ushort)7, parsed.FragmentId);
        Assert.Equal((ushort)12, parsed.FragmentCount);
        Assert.Equal((ushort)1180, parsed.PayloadSize);
        Assert.Equal(0x51, buf[0]); // "Q"
        Assert.Equal(0x50, buf[3]); // "P"
    }

    [Fact]
    public void Header_RejectsBadMagicAndVersion()
    {
        var buf = new byte[QovPacketHeader.Size];
        new QovPacketHeader { Magic = 1, Version = 2 }.WriteTo(buf);
        Assert.Throws<InvalidDataException>(() => QovPacketHeader.Parse(buf));

        buf[0] = 0x51; buf[1] = 0x4F; buf[2] = 0x56; buf[3] = 0x50;
        buf[4] = 0x01; // v1 header retired in v2.0
        Assert.Throws<InvalidDataException>(() => QovPacketHeader.Parse(buf));
    }
}

public class QovChunkInspectorTests
{
    [Fact]
    public void Inspect_KeyframeHasNoBand()
    {
        var chunk = new byte[40];
        chunk[0] = QovTypes.ChunkTypeKeyframe;
        chunk[1] = QovTypes.ChunkFlagYuv;
        var (isKf, hasBand, band) = QovChunkInspector.Inspect(chunk);
        Assert.True(isKf);
        Assert.False(hasBand);
        Assert.Equal(-1, band);
    }

    [Fact]
    public void Inspect_RefreshBandByteLocation()
    {
        var chunk = new byte[40];
        chunk[0] = QovTypes.ChunkTypePframe;
        chunk[1] = (byte)(QovTypes.ChunkFlagYuv | QovTypes.ChunkFlagDctBlocks | QovTypes.ChunkFlagRefreshBand);
        chunk[10] = 5; // band byte leads the payload
        var (_, hasBand, band) = QovChunkInspector.Inspect(chunk);
        Assert.True(hasBand);
        Assert.Equal(5, band);

        // Compressed chunks carry the 4-byte uncompressed size first
        chunk[1] |= QovTypes.ChunkFlagCompressed;
        chunk[10] = 0;
        chunk[14] = 9;
        var (_, hasBand2, band2) = QovChunkInspector.Inspect(chunk);
        Assert.True(hasBand2);
        Assert.Equal(9, band2);
    }
}

public class QovPlaybackGateTests
{
    [Fact]
    public void Gate_NormalStreamDisplays()
    {
        var gate = new QovPlaybackGate();
        Assert.Equal(QovPlaybackDecision.Display, gate.OnFrameArrived(isKeyframe: false, hasRefreshBand: true));
        Assert.False(gate.IsHealing);
    }

    [Fact]
    public void Gate_HealsOverRefreshBandCycle()
    {
        var gate = new QovPlaybackGate();
        gate.OnFrameLost();

        int healFrames = 0;
        for (int i = 0; i < QovChunkInspector.RefreshBandCycle - 1; i++)
        {
            Assert.Equal(QovPlaybackDecision.Heal, gate.OnFrameArrived(isKeyframe: false, hasRefreshBand: true));
            healFrames++;
            Assert.True(gate.IsHealing);
        }
        Assert.Equal(QovChunkInspector.RefreshBandCycle - 1, healFrames);

        // 12th band P-frame completes the repaint: back to display
        Assert.Equal(QovPlaybackDecision.Display, gate.OnFrameArrived(isKeyframe: false, hasRefreshBand: true));
        Assert.False(gate.IsHealing);
    }

    [Fact]
    public void Gate_KeyframeResumesInstantly()
    {
        var gate = new QovPlaybackGate();
        gate.OnFrameLost();
        Assert.Equal(QovPlaybackDecision.Heal, gate.OnFrameArrived(isKeyframe: false, hasRefreshBand: true));
        Assert.Equal(QovPlaybackDecision.Display, gate.OnFrameArrived(isKeyframe: true, hasRefreshBand: false));
        Assert.False(gate.IsHealing);
    }

    [Fact]
    public void Gate_NoBandsInStream_RequestsKeyframeRateLimited()
    {
        // 60 s window: a second request within the test is impossible, so the
        // rate limit is verified without wall-clock sensitivity
        var gate = new QovPlaybackGate(keyframeRequestIntervalMs: 60_000);
        int requests = 0;
        gate.OnKeyframeRequest += () => requests++;

        gate.OnFrameLost();
        for (int i = 0; i < 10; i++)
            Assert.Equal(QovPlaybackDecision.Heal, gate.OnFrameArrived(isKeyframe: false, hasRefreshBand: false));

        Assert.Equal(1, requests);
        Assert.True(gate.IsHealing);
    }
}

public class QovAdaptationControllerTests
{
    [Fact]
    public void FecRatio_FollowsLoss()
    {
        var c = new QovAdaptationController(60);
        c.OnReport(lossPercent: 1.0, rttMs: 20, bufferMs: 200, frameIntervalMs: 33, deliveredRatio: 0.99);
        Assert.Equal(4, c.FecGroupSize);

        c.OnReport(lossPercent: 0.3, rttMs: 20, bufferMs: 200, frameIntervalMs: 33, deliveredRatio: 0.99);
        Assert.Equal(0, c.FecGroupSize);

        c.OnReport(lossPercent: 2.5, rttMs: 20, bufferMs: 200, frameIntervalMs: 33, deliveredRatio: 0.99);
        Assert.Equal(3, c.FecGroupSize);

        c.OnReport(lossPercent: 6.0, rttMs: 20, bufferMs: 200, frameIntervalMs: 33, deliveredRatio: 0.99);
        Assert.Equal(3, c.FecGroupSize);
    }

    [Fact]
    public void SustainedHighLoss_DropsReference()
    {
        var c = new QovAdaptationController(60);
        int drops = 0;
        c.ReferenceDropped += () => drops++;

        for (int i = 0; i < 2; i++)
            c.OnReport(10, 20, 200, 33, 0.8);
        Assert.Equal(0, drops);

        c.OnReport(10, 20, 200, 33, 0.8);
        Assert.Equal(1, drops);

        c.OnReport(0, 20, 200, 33, 1.0);
        c.OnReport(0, 20, 200, 33, 1.0);
        Assert.Equal(1, drops);
    }

    [Fact]
    public void Deficit_LowersQualityWithFloor()
    {
        var c = new QovAdaptationController(60, qualityChangeCooldownMs: 0);
        var seen = new List<int>();
        c.QualityChanged += q => seen.Add(q);

        c.OnReport(0.2, 20, 200, 33, 0.5); // ratio 0.5 -> q - 10
        Assert.Equal(50, c.CurrentQuality);

        c.OnReport(0.2, 20, 200, 33, 0.5);
        Assert.Equal(40, c.CurrentQuality);
        Assert.Equal(new[] { 50, 40 }, seen);
    }

    [Fact]
    public void QualityChanges_RateLimitedToOnePerCooldown()
    {
        var c = new QovAdaptationController(60, qualityChangeCooldownMs: 60_000);
        var seen = new List<int>();
        c.QualityChanged += q => seen.Add(q);

        c.OnReport(0.2, 20, 200, 33, 0.5);
        c.OnReport(0.2, 20, 200, 33, 0.5);
        c.OnReport(0.2, 20, 200, 33, 0.5);

        Assert.Equal(50, c.CurrentQuality);
        Assert.Equal(new[] { 50 }, seen);
    }

    [Fact]
    public void SustainedSurplus_RaisesQualityToStart()
    {
        var c = new QovAdaptationController(60, qualityChangeCooldownMs: 0);
        c.OnReport(0.2, 20, 200, 33, 0.5);
        Assert.Equal(50, c.CurrentQuality);

        for (int i = 0; i < 3; i++)
            c.OnReport(0.2, 20, 200, 33, 0.99);
        Assert.Equal(60, c.CurrentQuality);

        // Ceiling = start quality
        c.OnReport(0.2, 20, 200, 33, 0.99);
        c.OnReport(0.2, 20, 200, 33, 0.99);
        c.OnReport(0.2, 20, 200, 33, 0.99);
        Assert.Equal(60, c.CurrentQuality);
    }

    [Fact]
    public void BufferDrain_SkipsEveryOtherFrame()
    {
        var c = new QovAdaptationController(60);
        c.OnReport(0, 20, bufferMs: 20, frameIntervalMs: 33, deliveredRatio: 0.99);
        Assert.True(c.FrameSkipActive);

        bool a = c.ShouldSkipFrame(), b = c.ShouldSkipFrame(), d = c.ShouldSkipFrame();
        Assert.NotEqual(a, b);
        Assert.Equal(a, d);

        c.OnReport(0, 20, bufferMs: 200, frameIntervalMs: 33, deliveredRatio: 0.99);
        Assert.False(c.FrameSkipActive);
        Assert.False(c.ShouldSkipFrame());
    }
}
