using System.Collections.Concurrent;
using System.Diagnostics;
using Xunit;
using QovLibrary.Streaming;

namespace QovLibrary.Tests;

// In-process loopback over real TCP+UDP sockets: one QovStreamServer, one
// QovStreamClient, a deterministic loss filter on the server's outgoing
// datagrams. Verifies the v2.0 machinery end to end (session handshake,
// fragmentation, NACK retransmit, XOR FEC, playback deadlines, reports).
public class StreamingLoopbackTests
{
    private sealed class SampleStream
    {
        public byte[] Header = null!;
        public List<byte[]> Chunks = new();
        public long TotalChunkBytes;
    }

    private static SampleStream BuildSampleStream(int frames = 24, int width = 160, int height = 120, int fps = 30, int keyframeInterval = 1000)
    {
        int flags = QovTypes.FlagHasIndex | QovTypes.FlagIntraRefresh;
        var ms = new MemoryStream();
        var enc = new QovEncoder(ms, (ushort)width, (ushort)height, (ushort)fps, 1,
            (byte)flags, QovTypes.ColorspaceYuv420, useCompression: true, quality: 50);

        var rand = new Random(1234);
        for (int n = 0; n < frames; n++)
        {
            var pixels = new byte[width * height * 4];
            rand.NextBytes(pixels);
            uint ts = (uint)((long)n * 1_000_000 / fps);
            if (n % keyframeInterval == 0) enc.EncodeKeyframe(pixels, ts);
            else enc.EncodePFrame(pixels, ts);
        }
        enc.Finish();

        byte[] data = ms.ToArray();
        int headerSize = data[4] == 0x03 ? 32 : 24;
        var sample = new SampleStream { Header = data[..headerSize] };
        int off = headerSize;
        while (off < data.Length)
        {
            byte type = data[off];
            if (type is QovTypes.ChunkTypeEnd or QovTypes.ChunkTypeIndex) break; // file-level, not media
            Assert.True(type is QovTypes.ChunkTypeSync or QovTypes.ChunkTypeKeyframe or QovTypes.ChunkTypePframe,
                $"unexpected chunk type {type} in sample stream");
            int size = (data[off + 2] << 24) | (data[off + 3] << 16) | (data[off + 4] << 8) | data[off + 5];
            int total = 10 + size;
            var chunk = new byte[total];
            Array.Copy(data, off, chunk, 0, total);
            sample.Chunks.Add(chunk);
            sample.TotalChunkBytes += total;
            off += total;
        }
        Assert.True(sample.Chunks.Count >= frames, "sample should carry at least one chunk per frame");
        return sample;
    }

    private static async Task<(QovStreamServer Server, QovStreamClient Client)> ConnectPairAsync(byte[] header)
    {
        var server = new QovStreamServer(0, 0);
        server.SetSessionHeader(header);
        server.OnLog += m => Console.Error.WriteLine($"[server] {m}");
        var started = server.StartAsync();
        var mediaTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.OnMediaConnected += () => mediaTcs.TrySetResult();

        var client = new QovStreamClient();
        client.OnLog += m => Console.Error.WriteLine($"[client] {m}");
        await client.ConnectAsync("127.0.0.1", server.ControlPort, server.MediaPort);
        await started;

        var winner = await Task.WhenAny(mediaTcs.Task, Task.Delay(10_000));
        Assert.True(winner == mediaTcs.Task, "client UDP probe never reached the server");
        return (server, client);
    }

    private static async Task WaitUntilAsync(Func<bool> condition, string because, int timeoutMs = 15000)
    {
        var sw = Stopwatch.StartNew();
        while (!condition() && sw.ElapsedMilliseconds < timeoutMs)
            await Task.Delay(10);
        Assert.True(condition(), $"{because} (waited {sw.ElapsedMilliseconds} ms)");
    }

    private static async Task SendAllAsync(QovStreamServer server, IReadOnlyList<byte[]> chunks, int fps)
    {
        var pace = TimeSpan.FromMilliseconds(Math.Max(1, 1000 / fps));
        foreach (var chunk in chunks)
        {
            await server.SendFrameAsync(chunk, isAudio: false);
            await Task.Delay(pace);
        }
    }

    [Fact]
    public async Task Loopback_DeliversAllChunksIntact()
    {
        var sample = BuildSampleStream();
        var (server, client) = await ConnectPairAsync(sample.Header);
        using var _s = server;
        using var _c = client;

        var delivered = new ConcurrentQueue<byte[]>();
        client.OnFrameReceived += (chunk, type) => { if (type == QovPacketType.Video) delivered.Enqueue(chunk); };

        await SendAllAsync(server, sample.Chunks, fps: 30);

        await WaitUntilAsync(() => delivered.Count == sample.Chunks.Count, "all chunks delivered");

        Assert.Equal(0, client.FramesDropped);
        Assert.Equal(0, client.FecRecoveries);
        int i = 0;
        foreach (var got in delivered)
            Assert.True(got.AsSpan().SequenceEqual(sample.Chunks[i++]), $"chunk {i - 1} differs from source");
    }

    [Fact]
    public async Task Loopback_FecRepairsSinglePacketLoss()
    {
        var sample = BuildSampleStream(frames: 8, width: 320, height: 240, fps: 5); // 5 fps: 100 ms deadline absorbs the 121-packet keyframe burst
        int keyIdx = sample.Chunks.FindIndex(c => c.Length > 1180);
        Assert.True(keyIdx > 0, "sample should contain a multi-fragment chunk");
        uint targetFrame = (uint)(keyIdx + 1); // frame_id = chunk send order, 1-based

        var (server, client) = await ConnectPairAsync(sample.Header);
        using var _s = server;
        using var _c = client;
        server.FecGroupSize = 4;

        uint? firstSeq = null;
        server.OutgoingFilter = (seq, frameId, type) =>
        {
            if (type != QovPacketType.Video || frameId != targetFrame) return true;
            firstSeq ??= seq;
            return seq != firstSeq; // lost forever: FEC must repair it (NACK retransmits are also lost)
        };

        var delivered = new ConcurrentQueue<byte[]>();
        client.OnFrameReceived += (chunk, type) => { if (type == QovPacketType.Video) delivered.Enqueue(chunk); };

        await SendAllAsync(server, sample.Chunks, fps: 5);

        await WaitUntilAsync(() => delivered.Count == sample.Chunks.Count,
            $"all chunks delivered via FEC repair (delivered={delivered.Count} dropped={client.FramesDropped} fec={client.FecRecoveries})");
        Assert.Equal(1, client.FecRecoveries);
        Assert.Equal(0, client.FramesDropped);

        int i = 0;
        foreach (var got in delivered)
            Assert.True(got.AsSpan().SequenceEqual(sample.Chunks[i++]), $"chunk {i - 1} differs after FEC repair");
    }

    [Fact]
    public async Task Loopback_NackRetransmitRecoversDoubleLoss()
    {
        var sample = BuildSampleStream(frames: 8, width: 320, height: 240, fps: 5);
        int keyIdx = sample.Chunks.FindIndex(c => c.Length > 1180);
        Assert.True(keyIdx > 0, "sample should contain a multi-fragment chunk");
        uint targetFrame = (uint)(keyIdx + 1);

        var (server, client) = await ConnectPairAsync(sample.Header);
        using var _s = server;
        using var _c = client;
        server.FecGroupSize = 0; // NACK is the only recovery path

        uint? firstSeq = null;
        var suppressed = new HashSet<uint>();
        server.OutgoingFilter = (seq, frameId, type) =>
        {
            if (type != QovPacketType.Video || frameId != targetFrame) return true;
            firstSeq ??= seq;
            bool firstTime = suppressed.Add(seq);
            bool drop = firstTime && (seq == firstSeq || seq == firstSeq + 1);
            return !drop; // retransmissions pass through
        };

        var delivered = new ConcurrentQueue<byte[]>();
        client.OnFrameReceived += (chunk, type) => { if (type == QovPacketType.Video) delivered.Enqueue(chunk); };

        await SendAllAsync(server, sample.Chunks, fps: 5);

        await WaitUntilAsync(() => delivered.Count == sample.Chunks.Count, "all chunks delivered via NACK retransmit");
        Assert.Equal(0, client.FecRecoveries);
        Assert.Equal(0, client.FramesDropped);

        int i = 0;
        foreach (var got in delivered)
            Assert.True(got.AsSpan().SequenceEqual(sample.Chunks[i++]), $"chunk {i - 1} differs after NACK recovery");
    }

    [Fact]
    public async Task Loopback_WholeFrameLoss_DropsAndHealsViaRefreshBands()
    {
        var sample = BuildSampleStream(keyframeInterval: 1000); // only frame 0 is a keyframe
        var (server, client) = await ConnectPairAsync(sample.Header);
        using var _s = server;
        using var _c = client;
        server.FecGroupSize = 0;

        const uint lostFrame = 5;
        server.OutgoingFilter = (seq, frameId, type) => frameId != lostFrame; // never delivered

        var delivered = new ConcurrentQueue<byte[]>();
        var decisions = new ConcurrentQueue<QovPlaybackDecision>();
        var gate = new QovPlaybackGate();
        gate.OnKeyframeRequest += () => client.SendCommandAsync("KEYFRAME");
        client.OnFrameReceived += (chunk, type) =>
        {
            if (type != QovPacketType.Video) return;
            delivered.Enqueue(chunk);
            var (isKf, hasBand, _) = QovChunkInspector.Inspect(chunk);
            decisions.Enqueue(gate.OnFrameArrived(isKf, hasBand));
        };
        var droppedIds = new ConcurrentQueue<uint>();
        client.OnFrameDropped += frameId => { droppedIds.Enqueue(frameId); gate.OnFrameLost(); };

        await SendAllAsync(server, sample.Chunks, fps: 30);

        await WaitUntilAsync(() => delivered.Count == sample.Chunks.Count - 1, "all surviving chunks delivered");
        await WaitUntilAsync(() => !gate.IsHealing, "playback resumed after refresh-band cycle");

        Assert.True(client.FramesDropped == 1,
            $"FramesDropped={client.FramesDropped} ids=[{string.Join(",", droppedIds)}] delivered={delivered.Count}");
        Assert.True(droppedIds.Count == 1 && droppedIds.Contains(lostFrame),
            $"exactly frame {lostFrame} should drop, got [{string.Join(",", droppedIds)}]");
        Assert.True(decisions.Count(d => d == QovPlaybackDecision.Heal) >= QovChunkInspector.RefreshBandCycle - 1,
            "expected a healing run while the refresh band repaints the frame");
        Assert.Equal(QovPlaybackDecision.Display, decisions.Last());

        // Delivered chunks preserve decode order around the hole
        int src = 0;
        foreach (var got in delivered)
        {
            if (src == lostFrame - 1) src++; // skip the lost chunk
            Assert.True(got.AsSpan().SequenceEqual(sample.Chunks[src]), $"order broken at chunk {src}");
            src++;
        }
    }

    [Fact]
    public async Task Loopback_ReportsAndRttFlow()
    {
        var sample = BuildSampleStream(frames: 6);
        var (server, client) = await ConnectPairAsync(sample.Header);
        using var _s = server;
        using var _c = client;

        int reports = 0;
        double lastReportLoss = -1;
        uint lastSince = 0;
        server.OnReport += (loss, rttMs, bufMs, since) => { reports++; lastReportLoss = loss; lastSince = since; };

        var delivered = new ConcurrentQueue<byte[]>();
        client.OnFrameReceived += (chunk, type) => { if (type == QovPacketType.Video) delivered.Enqueue(chunk); };

        await SendAllAsync(server, sample.Chunks, fps: 30);

        await WaitUntilAsync(() => delivered.Count == sample.Chunks.Count, "chunks delivered");
        await WaitUntilAsync(() => reports >= 2, "receiver reports arrive every 500 ms");
        await WaitUntilAsync(() => client.LastRttMs >= 0, "PING/PONG RTT measured");

        // Loopback is best-effort under parallel test load; reports flow, so
        // loss must stay near zero, not exactly zero.
        Assert.True(lastReportLoss <= 2.0, $"unexpected report loss {lastReportLoss}%");
        Assert.True(lastSince > 0, "highest contiguous seq reported");

        // The ladder maps the observed report deterministically (the pure
        // mapping table is covered by QovAdaptationControllerTests).
        var adaptation = new QovAdaptationController(startQuality: 50);
        adaptation.OnReport(lastReportLoss, 20, 200, 33.3, deliveredRatio: 0.99);
        Assert.Equal(lastReportLoss < 0.5 ? 0 : lastReportLoss > 2.0 ? 3 : 4, adaptation.FecGroupSize);
    }
}
