// QOV-S v2.0 "Classic" binding reference (qov-streaming-spec.md section 1.2):
// TCP control channel + raw UDP media in datagram mode. Implements the v2.0
// core: HELLO/CONFIG session (section 2), 20-byte packetization (section 3),
// NACK retransmit and XOR FEC (section 5). The receive path (freeze + refresh
// band healing) and the adaptation ladder live in QovAdaptation.cs (section 6).
using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace QovLibrary.Streaming;

public enum QovPacketType : byte
{
    Video = 0x00,
    Audio = 0x01,
    Fec = 0x02,
    KeepAlive = 0xF0
}

// v2.0 packet header (spec section 3): magic(4) version(1) packet_type(1)
// seq(4) frame_id(4) fragment_id(2) fragment_count(2) payload_size(2)
public readonly struct QovPacketHeader
{
    public const uint MagicValue = 0x514F5650; // "QOVP"
    public const byte VersionValue = 0x02;
    public const int Size = 20;

    public uint Magic { get; init; }
    public byte Version { get; init; }
    public QovPacketType PacketType { get; init; }
    public uint Seq { get; init; }
    public uint FrameId { get; init; }
    public ushort FragmentId { get; init; }
    public ushort FragmentCount { get; init; }
    public ushort PayloadSize { get; init; }

    public void WriteTo(Span<byte> buffer)
    {
        BinaryPrimitives.WriteUInt32BigEndian(buffer[0..4], Magic);
        buffer[4] = Version;
        buffer[5] = (byte)PacketType;
        BinaryPrimitives.WriteUInt32BigEndian(buffer[6..10], Seq);
        BinaryPrimitives.WriteUInt32BigEndian(buffer[10..14], FrameId);
        BinaryPrimitives.WriteUInt16BigEndian(buffer[14..16], FragmentId);
        BinaryPrimitives.WriteUInt16BigEndian(buffer[16..18], FragmentCount);
        BinaryPrimitives.WriteUInt16BigEndian(buffer[18..20], PayloadSize);
    }

    public static QovPacketHeader Parse(ReadOnlySpan<byte> buffer)
    {
        if (buffer.Length < Size) throw new ArgumentException("Buffer too small for header");

        uint magic = BinaryPrimitives.ReadUInt32BigEndian(buffer[0..4]);
        if (magic != MagicValue) throw new InvalidDataException("Invalid Magic Bytes");
        byte version = buffer[4];
        if (version != VersionValue) throw new InvalidDataException($"Unsupported QOV-S packet version {version}");

        return new QovPacketHeader
        {
            Magic = magic,
            Version = version,
            PacketType = (QovPacketType)buffer[5],
            Seq = BinaryPrimitives.ReadUInt32BigEndian(buffer[6..10]),
            FrameId = BinaryPrimitives.ReadUInt32BigEndian(buffer[10..14]),
            FragmentId = BinaryPrimitives.ReadUInt16BigEndian(buffer[14..16]),
            FragmentCount = BinaryPrimitives.ReadUInt16BigEndian(buffer[16..18]),
            PayloadSize = BinaryPrimitives.ReadUInt16BigEndian(buffer[18..20])
        };
    }
}

// Control-channel line reader that never over-reads: the client's stream
// carries binary payload (CONFIG header) right after the newline, so buffered
// TextReader instances would swallow it.
internal static class ControlStream
{
    public static async Task<string?> ReadLineExactAsync(NetworkStream stream, CancellationToken ct)
    {
        var ms = new MemoryStream();
        var one = new byte[1];
        while (true)
        {
            int n = await stream.ReadAsync(one.AsMemory(0, 1), ct);
            if (n == 0) return ms.Length > 0 ? Encoding.UTF8.GetString(ms.ToArray()) : null;
            if (one[0] == '\n') return Encoding.UTF8.GetString(ms.ToArray());
            ms.WriteByte(one[0]);
        }
    }

    public static async Task SendLineAsync(NetworkStream stream, string line, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(line + "\n");
        await stream.WriteAsync(bytes.AsMemory(), ct);
    }

    public static Dictionary<string, string> ParseArgs(string line)
    {
        var args = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var t in line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            int eq = t.IndexOf('=');
            if (eq > 0) args[t[..eq]] = t[(eq + 1)..];
        }
        return args;
    }
}

public class QovStreamServer : IDisposable
{
    private readonly TcpListener _tcpListener;
    private readonly int _mediaPortRequest;
    private TcpClient? _tcpClient;
    private NetworkStream? _tcpStream;
    private UdpClient? _udpMedia;
    private IPEndPoint? _mediaRemote;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _tcpWriteLock = new(1, 1);

    private uint _seq = 0;
    private uint _currentFrameId = 0;
    // -interval, not long.MinValue (now - MinValue overflows and would
    // rate-limit the first KEYFRAME away)
    private long _lastKeyframeRequestMs = -KeyframeMinIntervalMs;
    private byte[]? _sessionHeader;

    // Config: v2.0 datagram-mode cap = 1200-byte packets (spec section 3)
    private const int MaxFragmentPayload = 1180;
    private const int ReplayCapacity = 1024;
    private const int KeyframeMinIntervalMs = 1000;

    // Retransmit replay window (spec section 5.1): recent media packets by seq
    private readonly object _replayLock = new();
    private readonly Dictionary<uint, byte[]> _replay = new();
    private readonly Queue<uint> _replayOrder = new();

    public int ControlPort => ((IPEndPoint?)_tcpListener.LocalEndpoint)?.Port ?? 0;
    public int MediaPort => _udpMedia != null
        ? ((IPEndPoint)_udpMedia.Client.LocalEndPoint!).Port
        : _mediaPortRequest;

    // XOR FEC group size: 4 (light 1:4), 3 (aggressive 1:3) or 0 (off); the
    // adaptation ladder (spec sections 5.2/6) drives this per receiver report.
    public int FecGroupSize { get; set; } = 4;

    // HELLO auth hook (spec section 2.2): return false to reject the token.
    public Func<string, bool>? TokenValidator { get; set; }

    // Test/measurement hook: (seq, frameId, type) -> true = transmit.
    public Func<uint, uint, QovPacketType, bool>? OutgoingFilter { get; set; }

    public event Action<string>? OnLog;
    public event Action? OnClientReady;     // HELLO accepted, CONFIG sent
    public event Action? OnMediaConnected;  // first datagram bound the media address
    public event Action? OnPlay;
    public event Action? OnPause;
    public event Action? OnKeyframeRequest; // already rate-limited to 1/s (spec section 2.2)
    public event Action<double, double, double, uint>? OnReport; // loss%, rttMs, bufferMs, sinceSeq

    public QovStreamServer(int controlPort, int mediaPort = 8881)
    {
        _tcpListener = new TcpListener(IPAddress.Any, controlPort);
        _mediaPortRequest = mediaPort;
    }

    // The QOV file header (24/32 bytes, spec v3.6 section 1) sent as CONFIG
    // payload right after a valid HELLO.
    public void SetSessionHeader(byte[] header) => _sessionHeader = header;

    public async Task StartAsync()
    {
        _tcpListener.Start();
        _udpMedia = new UdpClient(_mediaPortRequest);
        OnLog?.Invoke($"Server listening (control :{ControlPort}, media :{MediaPort})");

        _tcpClient = await _tcpListener.AcceptTcpClientAsync(_cts.Token);
        _tcpStream = _tcpClient.GetStream();
        OnLog?.Invoke($"Client connected: {_tcpClient.Client.RemoteEndPoint}");

        if (!await HandshakeAsync()) { Dispose(); return; }

        _ = Task.Run(ReceiveMediaLoop, _cts.Token);
        _ = Task.Run(ReceiveControlLoop, _cts.Token);
    }

    // Spec section 2.1: client sends HELLO, server validates and replies
    // CONFIG followed by the raw QOV file header bytes.
    private async Task<bool> HandshakeAsync()
    {
        var line = await ControlStream.ReadLineExactAsync(_tcpStream!, _cts.Token);
        if (line == null) return false;

        var args = ControlStream.ParseArgs(line);
        var verb = line.Split(' ', 2)[0].ToUpperInvariant();
        bool versionOk = args.TryGetValue("v", out var v) && v == "2";
        bool tokenOk = args.TryGetValue("token", out var token)
            && (TokenValidator == null || TokenValidator(token));
        if (verb != "HELLO" || !versionOk || !tokenOk || _sessionHeader == null)
        {
            OnLog?.Invoke("HELLO rejected; closing");
            return false;
        }

        await _tcpWriteLock.WaitAsync(_cts.Token);
        try
        {
            await ControlStream.SendLineAsync(_tcpStream!, "CONFIG", _cts.Token);
            await _tcpStream!.WriteAsync(_sessionHeader.AsMemory(), _cts.Token);
        }
        finally { _tcpWriteLock.Release(); }

        OnLog?.Invoke("Session established (CONFIG + header sent)");
        OnClientReady?.Invoke();
        return true;
    }

    private async Task ReceiveControlLoop()
    {
        var reader = new StreamReader(_tcpStream!, Encoding.UTF8);
        try
        {
            while (!_cts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(_cts.Token);
                if (line == null) break;
                await HandleControlLineAsync(line.Trim());
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            OnLog?.Invoke($"Control loop error: {ex.Message}");
        }
    }

    private async Task HandleControlLineAsync(string line)
    {
        if (line.Length == 0) return;
        var verb = line.Split(' ', 2)[0].ToUpperInvariant();
        switch (verb)
        {
            case "PLAY": OnPlay?.Invoke(); break;
            case "PAUSE": OnPause?.Invoke(); break;
            case "KEYFRAME":
                long now = Environment.TickCount64;
                if (now - _lastKeyframeRequestMs < KeyframeMinIntervalMs)
                {
                    OnLog?.Invoke("KEYFRAME rate-limited");
                    break;
                }
                _lastKeyframeRequestMs = now;
                OnKeyframeRequest?.Invoke();
                break;
            case "PING":
            {
                var args = ControlStream.ParseArgs(line);
                await SendControlAsync(args.TryGetValue("t", out var t) ? $"PONG t={t}" : "PONG");
                break;
            }
            case "REPORT":
            {
                var args = ControlStream.ParseArgs(line);
                double loss = args.TryGetValue("loss", out var l) && double.TryParse(l, out var lv) ? lv : 0;
                double rttUs = args.TryGetValue("rtt", out var r) && double.TryParse(r, out var rv) ? rv : 0;
                double bufMs = args.TryGetValue("buf", out var b) && double.TryParse(b, out var bv) ? bv : 0;
                uint since = args.TryGetValue("since", out var s) && uint.TryParse(s, out var sv) ? sv : 0;
                OnReport?.Invoke(loss, rttUs / 1000.0, bufMs, since);
                break;
            }
            case "NACK":
                await RetransmitAsync(line);
                break;
            case "BYE": Dispose(); break;
        }
    }

    private async Task SendControlAsync(string msg)
    {
        if (_tcpStream == null) return;
        await _tcpWriteLock.WaitAsync(_cts.Token);
        try { await ControlStream.SendLineAsync(_tcpStream, msg, _cts.Token); }
        finally { _tcpWriteLock.Release(); }
    }

    // Spec section 5.1: retransmit listed datagrams still inside the replay
    // window; older ones are ignored (the receiver already dropped the frame).
    private async Task RetransmitAsync(string nackLine)
    {
        var udp = _udpMedia; var remote = _mediaRemote;
        if (udp == null || remote == null) return;

        foreach (var tok in nackLine.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!tok.StartsWith("seq=", StringComparison.Ordinal)) continue;
            var range = tok[4..];
            int dash = range.IndexOf('-');
            uint from, to;
            if (dash > 0)
            {
                if (!uint.TryParse(range[..dash], out from) || !uint.TryParse(range[(dash + 1)..], out to)) continue;
                if (to < from || to - from > 1024) continue;
            }
            else
            {
                if (!uint.TryParse(range, out from)) continue;
                to = from;
            }
            for (uint seq = from; seq <= to; seq++)
            {
                byte[]? packet;
                lock (_replayLock) { _replay.TryGetValue(seq, out packet); }
                if (packet == null) continue;
                var header = QovPacketHeader.Parse(packet);
                await SendDatagramAsync(udp, remote, packet, header.Seq, header.FrameId, header.PacketType);
            }
        }
    }

    private async Task SendDatagramAsync(UdpClient udp, IPEndPoint remote, byte[] packet, uint seq, uint frameId, QovPacketType type)
    {
        var filter = OutgoingFilter;
        if (filter != null && !filter(seq, frameId, type))
        {
            OnLog?.Invoke($"tx filtered: seq={seq} frame={frameId}");
            return;
        }
        await udp.SendAsync(packet, packet.Length, remote);
    }

    private void RememberReplay(uint seq, byte[] packet)
    {
        lock (_replayLock)
        {
            if (!_replay.TryAdd(seq, packet)) return;
            _replayOrder.Enqueue(seq);
            while (_replayOrder.Count > ReplayCapacity)
                _replay.Remove(_replayOrder.Dequeue());
        }
    }

    // Spec section 3 sender: one QOV chunk -> ceil(len/1180) fragments with a
    // shared frame_id, seq incrementing across all packets; XOR parity per
    // full group of same-frame packets (spec section 5.2).
    public async Task SendFrameAsync(byte[] frameData, bool isAudio)
    {
        var udp = _udpMedia; var remote = _mediaRemote;
        if (udp == null || remote == null)
        {
            OnLog?.Invoke("Media path not connected; frame dropped");
            return;
        }

        uint frameId = (uint)Interlocked.Increment(ref _currentFrameId);
        int fragCount = Math.Max(1, (frameData.Length + MaxFragmentPayload - 1) / MaxFragmentPayload);
        var type = isAudio ? QovPacketType.Audio : QovPacketType.Video;

        var packets = new List<byte[]>(fragCount);
        var seqs = new uint[fragCount];
        for (ushort i = 0; i < fragCount; i++)
        {
            int offset = i * MaxFragmentPayload;
            int size = Math.Min(MaxFragmentPayload, frameData.Length - offset);
            var packet = new byte[QovPacketHeader.Size + size];
            seqs[i] = NextSeq();
            new QovPacketHeader
            {
                Magic = QovPacketHeader.MagicValue,
                Version = QovPacketHeader.VersionValue,
                Seq = seqs[i],
                FrameId = frameId,
                FragmentId = i,
                FragmentCount = (ushort)fragCount,
                PayloadSize = (ushort)size,
                PacketType = type
            }.WriteTo(packet);
            Array.Copy(frameData, offset, packet, QovPacketHeader.Size, size);
            packets.Add(packet);
            RememberReplay(seqs[i], packet);
        }

        for (int i = 0; i < packets.Count; i++)
            await SendDatagramAsync(udp, remote, packets[i], seqs[i], frameId, type);

        int k = FecGroupSize;
        if (!isAudio && (k == 3 || k == 4))
        {
            for (int g = 0; g + k <= packets.Count; g += k)
            {
                // Parity payload = XOR of the group's full datagrams (headers
                // included) zero-padded to the longest (spec section 5.2).
                int bodyLen = 0;
                for (int i = g; i < g + k; i++) bodyLen = Math.Max(bodyLen, packets[i].Length);

                var parityBody = new byte[bodyLen];
                for (int i = g; i < g + k; i++)
                {
                    var p = packets[i];
                    for (int b = 0; b < p.Length; b++) parityBody[b] ^= p[b];
                }

                var parity = new byte[QovPacketHeader.Size + bodyLen];
                new QovPacketHeader
                {
                    Magic = QovPacketHeader.MagicValue,
                    Version = QovPacketHeader.VersionValue,
                    Seq = seqs[g], // group's first seq identifies the group (spec 5.2)
                    FrameId = frameId,
                    FragmentId = 0,
                    FragmentCount = (ushort)k,
                    PayloadSize = (ushort)bodyLen,
                    PacketType = QovPacketType.Fec
                }.WriteTo(parity);
                Array.Copy(parityBody, 0, parity, QovPacketHeader.Size, bodyLen);
                await SendDatagramAsync(udp, remote, parity, seqs[g], frameId, QovPacketType.Fec);
            }
        }
    }

    public async Task SendKeepAliveAsync()
    {
        var udp = _udpMedia; var remote = _mediaRemote;
        if (udp == null || remote == null) return;
        var packet = new byte[QovPacketHeader.Size];
        new QovPacketHeader
        {
            Magic = QovPacketHeader.MagicValue,
            Version = QovPacketHeader.VersionValue,
            Seq = NextSeq(),
            FrameId = _currentFrameId,
            FragmentId = 0,
            FragmentCount = 1,
            PayloadSize = 0,
            PacketType = QovPacketType.KeepAlive
        }.WriteTo(packet);
        await SendDatagramAsync(udp, remote, packet, 0, 0, QovPacketType.KeepAlive);
    }

    private uint NextSeq() => (uint)Interlocked.Increment(ref _seq);

    // Spec section 7 (Classic binding): the server binds the session to the
    // first datagram source address (the client's empty probe).
    private async Task ReceiveMediaLoop()
    {
        try
        {
            while (!_cts.Token.IsCancellationRequested)
            {
                var res = await _udpMedia!.ReceiveAsync(_cts.Token);
                if (_mediaRemote == null)
                {
                    _mediaRemote = res.RemoteEndPoint;
                    OnLog?.Invoke($"Media path bound: {_mediaRemote}");
                    OnMediaConnected?.Invoke();
                }
                else if (!_mediaRemote.Equals(res.RemoteEndPoint))
                {
                    continue; // single-session reference: ignore foreign sources
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            OnLog?.Invoke($"Media loop error: {ex.Message}");
        }
    }

    public void Dispose()
    {
        try
        {
            _cts.Cancel();
            _tcpClient?.Close();
            _tcpListener.Stop();
            _udpMedia?.Close();
        }
        catch { }
    }
}

public class QovStreamClient : IDisposable
{
    private TcpClient? _tcpClient;
    private NetworkStream? _tcpStream;
    private UdpClient? _udp;
    private IPEndPoint? _serverMedia;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _tcpWriteLock = new(1, 1);
    private readonly object _lock = new();

    // Reassembly (spec section 3 receiver): frameId -> state
    private readonly Dictionary<uint, FrameReassembly> _pending = new();
    private readonly Dictionary<uint, byte[]> _completedVideo = new();
    private uint _nextVideoFrameId;
    private bool _videoInit;
    private uint _resolvedUpTo;

    // Seq bookkeeping for loss detection + receiver report (spec section 6)
    private readonly HashSet<uint> _receivedSeq = new();
    private readonly Queue<uint> _seqOrder = new();
    private const int SeqWindow = 4096;
    private uint _highestSeq;
    private uint _contiguous;
    private uint _contiguousMark;
    private bool _seqInit;
    private long _receivedCount;
    private readonly Dictionary<uint, DateTime> _nackPending = new();

    // Stats
    private long _framesDelivered;
    private long _framesDropped;
    private long _fecRecoveries;
    private double _lastRttMs = -1;
    private long _lastPingSentMs;

    private byte[]? _header;
    private double _frameIntervalMs = 100;

    public event Action<string>? OnLog;
    public event Action<byte[]>? OnHeaderReceived;
    // Complete QOV chunks, in decode order for video (spec section 6)
    public event Action<byte[], QovPacketType>? OnFrameReceived;
    public event Action<uint>? OnFrameDropped;

    public long FramesDelivered => Interlocked.Read(ref _framesDelivered);
    public long FramesDropped => Interlocked.Read(ref _framesDropped);
    public long FecRecoveries => Interlocked.Read(ref _fecRecoveries);
    public long PacketsReceived => Interlocked.Read(ref _receivedCount);
    public double LastRttMs => _lastRttMs;

    private sealed class FrameReassembly
    {
        public byte[][] Packets;      // full datagrams (header + payload)
        public uint[] PacketSeq;
        public int ReceivedCount;
        public int FragmentCount;
        public DateTime CreatedAt;
        public QovPacketType Type;
        // parity payloads + group bounds (first seq, group size) from the header
        public List<(byte[] Payload, uint FirstSeq, int GroupSize)> Parities = new();

        public FrameReassembly(ushort fragmentCount, QovPacketType type)
        {
            FragmentCount = fragmentCount;
            Type = type;
            Packets = Array.Empty<byte[]>();
            PacketSeq = Array.Empty<uint>();
            CreatedAt = DateTime.UtcNow;
        }

        // Expected-missing placeholder (FragmentCount 0): a frame_id hole
        // whose packets never arrived; expires at the playback deadline.
        public static FrameReassembly Phantom(DateTime createdAt) =>
            new(0, QovPacketType.Video) { CreatedAt = createdAt };

        public void Allocate(ushort fragmentCount)
        {
            FragmentCount = fragmentCount;
            Packets = new byte[fragmentCount][];
            PacketSeq = new uint[fragmentCount];
        }
    }

    public async Task ConnectAsync(string host, int controlPort, int serverMediaPort, string token = "dev")
    {
        _tcpClient = new TcpClient();
        await _tcpClient.ConnectAsync(host, controlPort, _cts.Token);
        _tcpStream = _tcpClient.GetStream();
        _serverMedia = new IPEndPoint((await Dns.GetHostAddressesAsync(host))[0], serverMediaPort);

        await SendLineAsync("HELLO token=" + token + " v=2");

        _udp = new UdpClient(0); // bind now: the probe must source from a fixed port
        _udp.Client.ReceiveBufferSize = 4 << 20; // absorb sender bursts (loopback + LAN)
        OnLog?.Invoke($"Connected to {host}:{controlPort} (media target :{serverMediaPort})");

        _ = Task.Run(ReceiveTcpLoop, _cts.Token);
        _ = Task.Run(ReceiveUdpLoop, _cts.Token);
        _ = Task.Run(DeadlineLoop, _cts.Token);
        _ = Task.Run(ControlTimerLoop, _cts.Token);
    }

    public Task SendCommandAsync(string cmd) => SendLineAsync(cmd);

    private async Task SendLineAsync(string line)
    {
        if (_tcpStream == null) return;
        await _tcpWriteLock.WaitAsync(_cts.Token);
        try { await ControlStream.SendLineAsync(_tcpStream, line, _cts.Token); }
        finally { _tcpWriteLock.Release(); }
    }

    private async Task ReceiveTcpLoop()
    {
        try
        {
            while (!_cts.Token.IsCancellationRequested)
            {
                var line = await ControlStream.ReadLineExactAsync(_tcpStream!, _cts.Token);
                if (line == null) break;

                if (line == "CONFIG")
                {
                    await ReadSessionHeaderAsync();
                }
                else if (line.StartsWith("PONG", StringComparison.Ordinal))
                {
                    var args = ControlStream.ParseArgs(line);
                    if (args.TryGetValue("t", out var t) && long.TryParse(t, out var sentUs))
                        _lastRttMs = (NowUs() - sentUs) / 1000.0;
                }
                else if (line.StartsWith("PING", StringComparison.Ordinal))
                {
                    var args = ControlStream.ParseArgs(line);
                    await SendLineAsync(args.TryGetValue("t", out var t) ? $"PONG t={t}" : "PONG");
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            OnLog?.Invoke($"TCP loop error: {ex.Message}");
        }
    }

    private async Task ReadSessionHeaderAsync()
    {
        var base24 = await ReadExactAsync(24);
        byte[] header;
        if (base24[4] == 0x03) // lossy version carries the 32-byte header
        {
            var ext = await ReadExactAsync(8);
            header = new byte[32];
            Array.Copy(base24, header, 24);
            Array.Copy(ext, 0, header, 24, 8);
        }
        else
        {
            header = base24;
        }
        ushort num = (ushort)((header[10] << 8) | header[11]);
        ushort den = (ushort)((header[12] << 8) | header[13]);
        if (num > 0) _frameIntervalMs = Math.Clamp(1000.0 * den / num, 1, 1000);

        _header = header;
        OnHeaderReceived?.Invoke(header);
        await SendProbeAsync();
    }

    private async Task<byte[]> ReadExactAsync(int count)
    {
        var buf = new byte[count];
        int read = 0;
        while (read < count)
        {
            int n = await _tcpStream!.ReadAsync(buf.AsMemory(read, count - read), _cts.Token);
            if (n == 0) throw new EndOfStreamException("Connection closed");
            read += n;
        }
        return buf;
    }

    // Spec section 2.1 step 3: one empty probe packet the server learns.
    private async Task SendProbeAsync()
    {
        try { await _udp!.SendAsync(ReadOnlyMemory<byte>.Empty, _serverMedia!); }
        catch (Exception ex) { OnLog?.Invoke($"Probe failed: {ex.Message}"); }
    }

    private async Task ReceiveUdpLoop()
    {
        try
        {
            while (!_cts.Token.IsCancellationRequested)
            {
                var res = await _udp!.ReceiveAsync(_cts.Token);
                if (res.Buffer.Length < QovPacketHeader.Size) continue;

                QovPacketHeader header;
                try { header = QovPacketHeader.Parse(res.Buffer); }
                catch { continue; }

                var packet = res.Buffer.ToArray();
                if (header.PacketType != QovPacketType.Fec) RecordSeq(header.Seq);

                switch (header.PacketType)
                {
                    case QovPacketType.Video:
                    case QovPacketType.Audio:
                        HandleFragment(header, packet);
                        break;
                    case QovPacketType.Fec:
                        HandleParity(header, packet);
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            OnLog?.Invoke($"UDP error: {ex.Message}");
        }
    }

    private void RecordSeq(uint seq)
    {
        bool newGaps = false;
        lock (_lock)
        {
            if (!_seqInit)
            {
                _seqInit = true;
                _highestSeq = seq;
                _contiguous = seq;
            }
            else if (seq > _highestSeq)
            {
                for (uint s = _highestSeq + 1; s < seq; s++)
                    newGaps |= _nackPending.TryAdd(s, DateTime.UtcNow);
                _highestSeq = seq;
            }
            if (_receivedSeq.Add(seq))
            {
                _receivedCount++;
                _seqOrder.Enqueue(seq);
                while (_seqOrder.Count > SeqWindow)
                    _receivedSeq.Remove(_seqOrder.Dequeue());
                while (_receivedSeq.Contains(_contiguous + 1))
                    _contiguous++;
            }
        }
        // Spec section 5.1: NACK immediately on gap detection (each missing
        // seq requested once); the timer loop is the coalescing backstop.
        if (newGaps) _ = Task.Run(FlushNackAsync);
    }

    private void HandleFragment(QovPacketHeader header, byte[] packet)
    {
        List<byte[]>? toDeliver = null;
        QovPacketType deliverType = default;

        lock (_lock)
        {
            if (header.FrameId == 0) return;
            if (_videoInit && header.FrameId <= _resolvedUpTo) return; // late, frame resolved

            // Video frame_id holes below this packet infer frames whose
            // packets never arrived: track them so the watermark can advance.
            if (header.PacketType == QovPacketType.Video && _videoInit)
            {
                for (uint f = _nextVideoFrameId; f < header.FrameId; f++)
                    if (!_pending.ContainsKey(f) && !_completedVideo.ContainsKey(f))
                        _pending[f] = FrameReassembly.Phantom(DateTime.UtcNow);
            }

            if (!_pending.TryGetValue(header.FrameId, out var frame))
            {
                frame = new FrameReassembly(header.FragmentCount, header.PacketType);
                frame.Allocate(header.FragmentCount);
                _pending[header.FrameId] = frame;
            }
            else if (frame.FragmentCount == 0)
            {
                // phantom upgraded by a real fragment (deadline clock preserved)
                frame.Allocate(header.FragmentCount);
            }
            if (header.FragmentId >= frame.FragmentCount) return;

            if (frame.Packets[header.FragmentId] == null)
            {
                frame.Packets[header.FragmentId] = packet;
                frame.PacketSeq[header.FragmentId] = header.Seq;
                frame.ReceivedCount++;
            }

            if (frame.ReceivedCount == frame.FragmentCount)
            {
                _pending.Remove(header.FrameId);
                if (frame.Type == QovPacketType.Audio)
                {
                    toDeliver = new List<byte[]> { AssembleChunk(frame) };
                    deliverType = QovPacketType.Audio;
                }
                else
                {
                    _completedVideo[header.FrameId] = AssembleChunk(frame);
                    toDeliver = DeliverInOrderVideo();
                    deliverType = QovPacketType.Video;
                }
            }
        }

        if (toDeliver != null)
            foreach (var chunk in toDeliver) OnFrameReceived?.Invoke(chunk, deliverType);
    }

    private void HandleParity(QovPacketHeader header, byte[] packet)
    {
        lock (_lock)
        {
            if (!_pending.TryGetValue(header.FrameId, out var frame)) return;
            int body = Math.Min(header.PayloadSize, packet.Length - QovPacketHeader.Size);
            var payload = new byte[body];
            Array.Copy(packet, QovPacketHeader.Size, payload, 0, body);
            frame.Parities.Add((payload, header.Seq, header.FragmentCount));
        }
    }

    // Playback deadline (spec section 3): one frame interval, hard cap 100 ms.
    private TimeSpan Deadline() => TimeSpan.FromMilliseconds(Math.Min(_frameIntervalMs, 100));

    private async Task DeadlineLoop()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(5));
            while (await timer.WaitForNextTickAsync(_cts.Token))
                SweepDeadlines();
        }
        catch (OperationCanceledException) { }
    }

    private void SweepDeadlines()
    {
        List<byte[]>? videoReady = null;
        List<byte[]>? audioReady = null;
        var droppedIds = new List<uint>();

        lock (_lock)
        {
            var now = DateTime.UtcNow;
            foreach (var (frameId, frame) in _pending.ToList())
            {
                if (now - frame.CreatedAt < Deadline()) continue;

                if (frame.FragmentCount == 0)
                {
                    // expected-missing frame: never arrived, expire it so the
                    // decode-order watermark advances (spec section 6)
                    _pending.Remove(frameId);
                    Interlocked.Increment(ref _framesDropped);
                    droppedIds.Add(frameId);
                    AdvanceWatermarkOnDrop(frameId);
                    continue;
                }

                TryRepair(frame);

                _pending.Remove(frameId);
                if (frame.ReceivedCount == frame.FragmentCount)
                {
                    if (frame.Type == QovPacketType.Audio)
                    {
                        audioReady ??= new List<byte[]>();
                        audioReady.Add(AssembleChunk(frame));
                        Interlocked.Increment(ref _framesDelivered);
                    }
                    else
                    {
                        _completedVideo[frameId] = AssembleChunk(frame);
                    }
                }
                else
                {
                    Interlocked.Increment(ref _framesDropped);
                    droppedIds.Add(frameId);
                    if (frame.Type == QovPacketType.Video)
                        AdvanceWatermarkOnDrop(frameId);
                }
            }

            var more = DeliverInOrderVideo();
            if (more != null)
            {
                videoReady ??= new List<byte[]>();
                videoReady.AddRange(more);
            }
        }

        // Drop notifications reach the app BEFORE later frames are delivered:
        // the playback gate must be healing while the post-loss frames arrive.
        foreach (var id in droppedIds) OnFrameDropped?.Invoke(id);
        if (audioReady != null)
            foreach (var chunk in audioReady) OnFrameReceived?.Invoke(chunk, QovPacketType.Audio);
        if (videoReady != null)
            foreach (var chunk in videoReady) OnFrameReceived?.Invoke(chunk, QovPacketType.Video);
    }

    // Spec section 6: video chunks are delivered in decode order; a dropped
    // frame advances the watermark so late retransmits are discarded.
    private List<byte[]>? DeliverInOrderVideo()
    {
        if (!_videoInit && _completedVideo.Count > 0)
        {
            _videoInit = true;
            _nextVideoFrameId = _completedVideo.Keys.Min();
        }
        List<byte[]>? ready = null;
        while (_completedVideo.Remove(_nextVideoFrameId, out var chunk))
        {
            ready ??= new List<byte[]>();
            ready.Add(chunk);
            Interlocked.Increment(ref _framesDelivered);
            _resolvedUpTo = _nextVideoFrameId;
            _nextVideoFrameId++;
        }
        return ready;
    }

    // A dropped video frame must advance the decode-order watermark, or
    // delivery stalls behind the hole and phantom holes re-create forever.
    private void AdvanceWatermarkOnDrop(uint frameId)
    {
        if (!_videoInit)
        {
            _videoInit = true;
            _nextVideoFrameId = frameId + 1;
        }
        else if (frameId >= _nextVideoFrameId)
        {
            _nextVideoFrameId = frameId + 1;
        }
        _resolvedUpTo = Math.Max(_resolvedUpTo, frameId);
    }

    // Spec section 5.2: a receiver missing exactly one group member
    // reconstructs the full datagram from the parity packet.
    private void TryRepair(FrameReassembly frame)
    {
        if (frame.FragmentCount == 0) return;
        foreach (var parity in frame.Parities)
        {
            // The parity covers exactly one group of consecutive same-frame
            // packets (seqs [firstSeq, firstSeq + groupSize)); reconstruction
            // works only when the hole is inside that group.
            var (parityBody, firstSeq, groupSize) = parity;
            if (parityBody.Length == 0 || groupSize < 2) continue;

            var recon = new byte[parityBody.Length];
            Array.Copy(parityBody, recon, parityBody.Length);
            int groupMembers = 0;
            for (int i = 0; i < frame.FragmentCount; i++)
            {
                var p = frame.Packets[i];
                if (p == null) continue;
                uint s = frame.PacketSeq[i];
                if (s >= firstSeq && s < firstSeq + (uint)groupSize)
                {
                    groupMembers++;
                    for (int b = 0; b < p.Length; b++) recon[b] ^= p[b];
                }
            }
            if (groupMembers != groupSize - 1) continue; // hole not (only) in this group

            QovPacketHeader repaired;
            try { repaired = QovPacketHeader.Parse(recon); }
            catch { continue; }
            if (repaired.FragmentId >= frame.FragmentCount) continue;
            if (frame.Packets[repaired.FragmentId] != null) continue;

            frame.Packets[repaired.FragmentId] = recon;
            frame.PacketSeq[repaired.FragmentId] = repaired.Seq;
            frame.ReceivedCount++;
            Interlocked.Increment(ref _fecRecoveries);
            break; // hole filled; other parities see no hole
        }
    }

    private static byte[] AssembleChunk(FrameReassembly frame)
    {
        int total = 0;
        for (int i = 0; i < frame.FragmentCount; i++)
        {
            var p = frame.Packets[i]!;
            total += (int)QovPacketHeader.Parse(p).PayloadSize;
        }
        var chunk = new byte[total];
        int offset = 0;
        for (int i = 0; i < frame.FragmentCount; i++)
        {
            var p = frame.Packets[i]!;
            var header = QovPacketHeader.Parse(p);
            Array.Copy(p, QovPacketHeader.Size, chunk, offset, header.PayloadSize);
            offset += header.PayloadSize;
        }
        return chunk;
    }

    private async Task ControlTimerLoop()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
            long lastPing = 0, lastReport = 0;
            while (await timer.WaitForNextTickAsync(_cts.Token))
            {
                await FlushNackAsync();

                long now = Environment.TickCount64;
                if (now - lastPing >= 500)
                {
                    lastPing = now;
                    _lastPingSentMs = now;
                    await SendLineAsync($"PING t={NowUs()}");
                }
                if (now - lastReport >= 500)
                {
                    lastReport = now;
                    await SendReportAsync();
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    // Spec section 5.1: report gaps immediately, coalescing within a 500 ms
    // window — each missing seq is requested once.
    private async Task FlushNackAsync()
    {
        uint[] missing;
        lock (_lock)
        {
            if (_nackPending.Count == 0) return;
            missing = _nackPending.Keys.ToArray();
            _nackPending.Clear();
        }
        Array.Sort(missing);

        var sb = new StringBuilder("NACK");
        int i = 0;
        while (i < missing.Length)
        {
            uint from = missing[i], to = from;
            while (i + 1 < missing.Length && missing[i + 1] == to + 1) { to = missing[++i]; }
            sb.Append(" seq=").Append(from);
            if (to != from) sb.Append('-').Append(to);
            i++;
        }
        await SendLineAsync(sb.ToString());
    }

    // Spec section 6 receiver report: loss %, RTT, buffer depth, highest
    // contiguous seq — every 500 ms. Loss is measured up to the contiguity
    // watermark so packets still in flight are never counted as lost.
    private async Task SendReportAsync()
    {
        double loss; uint since; int bufMs;
        lock (_lock)
        {
            uint top = _contiguous;
            long expected = _seqInit ? top - _contiguousMark : 0;
            long missing = 0;
            for (uint s = _contiguousMark + 1; s <= top; s++)
                if (!_receivedSeq.Contains(s)) missing++;
            loss = expected > 0 ? missing * 100.0 / expected : 0;
            _contiguousMark = top;
            since = top;
            bufMs = (int)(_pending.Count * _frameIntervalMs);
        }
        long rttUs = _lastRttMs > 0 ? (long)(_lastRttMs * 1000) : 0;
        await SendLineAsync($"REPORT loss={(int)Math.Round(loss)} rtt={rttUs} buf={bufMs} since={since}");
    }

    private static long NowUs()
    {
        return (long)(Stopwatch.GetTimestamp() * 1_000_000.0 / Stopwatch.Frequency);
    }

    public byte[]? Header => _header;

    public void Dispose()
    {
        try
        {
            _cts.Cancel();
            _tcpClient?.Close();
            _udp?.Close();
        }
        catch { }
    }
}
