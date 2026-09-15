// QOV-S v2.0 "Classic" binding reference (qov-streaming-spec.md section 1.2):
// TCP control channel + raw UDP media in datagram mode. Packetization follows
// v2.0 section 3 (20-byte header with version + seq). Session subset:
// PLAY/PAUSE/KEYFRAME/PING/PONG/BYE; HELLO/CONFIG/REPORT/NACK pending.
using System.Buffers.Binary;
using System.Collections.Concurrent;
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

public class QovStreamServer : IDisposable
{
    private readonly TcpListener _tcpListener;
    private TcpClient? _tcpClient;
    private NetworkStream? _tcpStream;
    private readonly UdpClient _udpClient;
    private readonly CancellationTokenSource _cts = new();
    private uint _currentFrameId = 0;
    
    // Config: v2.0 datagram-mode cap = 1200-byte packets (spec section 3)
    private const int MaxUdpPayload = 1180;
    private uint _seq = 0;

    public event Action<string>? OnLog;
    public event Action? OnPlay;
    public event Action? OnPause;
    public event Action? OnKeyframeRequest;

    public QovStreamServer(int port)
    {
        _tcpListener = new TcpListener(IPAddress.Any, port);
        _udpClient = new UdpClient(); 
    }

    public async Task StartAsync()
    {
        _tcpListener.Start();
        OnLog?.Invoke($"Server listening on port {_tcpListener.LocalEndpoint}");

        // Wait for single client (simplified for reference impl)
        _tcpClient = await _tcpListener.AcceptTcpClientAsync(_cts.Token);
        _tcpStream = _tcpClient.GetStream();
        OnLog?.Invoke($"Client connected: {_tcpClient.Client.RemoteEndPoint}");
        
        // For this reference implementation, we assume the client is listening on port 8881
        // In a production environment, this would be negotiated.
        var remoteIp = ((IPEndPoint)_tcpClient.Client.RemoteEndPoint!).Address;
        _udpClient.Connect(remoteIp, 8881); 

        _ = Task.Run(ReceiveControlLoop);
    }

    public async Task SendHeaderAsync(byte[] headerData)
    {
        if (_tcpStream == null) return;
        // Header is 24 or 32 bytes.
        await _tcpStream.WriteAsync(headerData, _cts.Token);
        OnLog?.Invoke("Sent QOV Header via TCP");
    }

    private async Task ReceiveControlLoop()
    {
        if (_tcpStream == null) return;
        var reader = new StreamReader(_tcpStream, Encoding.UTF8);

        try
        {
            while (!_cts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(_cts.Token);
                if (line == null) break;

                switch (line.Trim().ToUpper())
                {
                    case "PLAY": OnPlay?.Invoke(); break;
                    case "PAUSE": OnPause?.Invoke(); break;
                    case "KEYFRAME": OnKeyframeRequest?.Invoke(); break;
                    case "PING": await SendControlAsync("PONG"); break;
                    case "BYE": Dispose(); break;
                }
            }
        }
        catch (Exception ex)
        {
            OnLog?.Invoke($"Control loop error: {ex.Message}");
        }
    }

    private async Task SendControlAsync(string msg)
    {
        if (_tcpStream == null) return;
        var bytes = Encoding.UTF8.GetBytes(msg + "\n");
        await _tcpStream.WriteAsync(bytes);
    }

    public async Task SendFrameAsync(byte[] frameData, bool isAudio)
    {
        if (_udpClient == null) return;

        uint frameId = Interlocked.Increment(ref _currentFrameId);
        int totalSize = frameData.Length;
        int fragmentCount = (totalSize + MaxUdpPayload - 1) / MaxUdpPayload;

        byte[] packetBuffer = new byte[QovPacketHeader.Size + MaxUdpPayload];

        for (ushort i = 0; i < fragmentCount; i++)
        {
            int offset = i * MaxUdpPayload;
            int size = Math.Min(MaxUdpPayload, totalSize - offset);

            var header = new QovPacketHeader
            {
                Magic = QovPacketHeader.MagicValue,
                Version = QovPacketHeader.VersionValue,
                Seq = (uint)Interlocked.Increment(ref _seq),
                FrameId = frameId,
                FragmentId = i,
                FragmentCount = (ushort)fragmentCount,
                PayloadSize = (ushort)size,
                PacketType = isAudio ? QovPacketType.Audio : QovPacketType.Video
            };

            header.WriteTo(packetBuffer);
            Array.Copy(frameData, offset, packetBuffer, QovPacketHeader.Size, size);

            await _udpClient.SendAsync(packetBuffer, QovPacketHeader.Size + size);
        }
    }

    public void Dispose()
    {
        try 
        {
            _cts.Cancel();
            _tcpClient?.Close();
            _tcpListener.Stop();
            _udpClient.Close();
        } 
        catch {}
    }
}

public class QovStreamClient : IDisposable
{
    private TcpClient? _tcpClient;
    private NetworkStream? _tcpStream;
    private UdpClient? _udpClient;
    private readonly CancellationTokenSource _cts = new();

    // Reassembly Buffer: FrameID -> ReassemblyState
    private readonly ConcurrentDictionary<uint, FrameReassembly> _pendingFrames = new();
    
    // To detect old frames
    private uint _lastCompletedFrameId = 0;

    public event Action<string>? OnLog;
    public event Action<byte[]>? OnHeaderReceived;
    public event Action<byte[], QovPacketType>? OnFrameReceived;

    private class FrameReassembly
    {
        public byte[]?[] Fragments;
        public int ReceivedCount;
        public int TotalFragments;
        public long CreatedAt;

        public FrameReassembly(int count)
        {
            Fragments = new byte[count][];
            TotalFragments = count;
            CreatedAt = DateTime.UtcNow.Ticks;
        }
    }

    public async Task ConnectAsync(string host, int tcpPort, int udpPort)
    {
        _tcpClient = new TcpClient();
        await _tcpClient.ConnectAsync(host, tcpPort);
        _tcpStream = _tcpClient.GetStream();
        
        OnLog?.Invoke($"Connected to TCP {host}:{tcpPort}");

        // Start UDP Listener
        _udpClient = new UdpClient(udpPort);
        OnLog?.Invoke($"Listening on UDP port {udpPort}");

        // Start loops
        _ = Task.Run(ReceiveTcpLoop);
        _ = Task.Run(ReceiveUdpLoop);
    }

    private async Task ReceiveTcpLoop()
    {
        if (_tcpStream == null) return;

        // 1. Read QOV Header (First 24-32 bytes)
        byte[] headerBuffer = new byte[32]; 
        int bytesRead = 0;
        
        try 
        {
            // Read first 24 bytes
            while (bytesRead < 24)
            {
                int n = await _tcpStream.ReadAsync(headerBuffer, bytesRead, 24 - bytesRead, _cts.Token);
                if (n == 0) throw new EndOfStreamException("Connection closed while reading header");
                bytesRead += n;
            }

            // Check version in byte 4 (Version 3 has 32 byte header)
            if (headerBuffer[4] == 0x03) 
            {
                while (bytesRead < 32)
                {
                    int n = await _tcpStream.ReadAsync(headerBuffer, bytesRead, 32 - bytesRead, _cts.Token);
                    if (n == 0) break;
                    bytesRead += n;
                }
            }

            var finalHeader = new byte[bytesRead];
            Array.Copy(headerBuffer, finalHeader, bytesRead);
            OnHeaderReceived?.Invoke(finalHeader);

            // 2. Command Loop
            var reader = new StreamReader(_tcpStream, Encoding.UTF8);
            while (!_cts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(_cts.Token);
                if (line == null) break;
                if (line.Trim() == "PONG") OnLog?.Invoke("Server Pong");
            }
        }
        catch (Exception ex)
        {
            OnLog?.Invoke($"TCP Loop Error: {ex.Message}");
        }
    }

    private async Task ReceiveUdpLoop()
    {
        if (_udpClient == null) return;

        try
        {
            while (!_cts.Token.IsCancellationRequested)
            {
                var result = await _udpClient.ReceiveAsync(_cts.Token);
                var buffer = result.Buffer;

                if (buffer.Length < QovPacketHeader.Size) continue;

                var header = QovPacketHeader.Parse(buffer);

                // Discard old frames or invalid IDs
                if ((header.FrameId <= _lastCompletedFrameId && _lastCompletedFrameId > 0 && header.FrameId != 0) || header.FrameId == 0) 
                {
                    continue; 
                }

                HandleFragment(header, buffer.AsSpan(QovPacketHeader.Size));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            OnLog?.Invoke($"UDP Error: {ex.Message}");
        }
    }

    private void HandleFragment(QovPacketHeader header, ReadOnlySpan<byte> payload)
    {
        // 1. Get or Create Reassembly State
        var frame = _pendingFrames.GetOrAdd(header.FrameId, _ => new FrameReassembly(header.FragmentCount));

        // 2. Store Fragment
        if (header.FragmentId < frame.Fragments.Length)
        {
            if (frame.Fragments[header.FragmentId] == null)
            {
                frame.Fragments[header.FragmentId] = payload.ToArray();
                Interlocked.Increment(ref frame.ReceivedCount);
            }
        }

        // 3. Check Completion
        if (frame.ReceivedCount == frame.TotalFragments)
        {
            if (_pendingFrames.TryRemove(header.FrameId, out var completedFrame))
            {
                // Reassemble
                using var ms = new MemoryStream();
                foreach (var frag in completedFrame.Fragments)
                {
                    if (frag != null) ms.Write(frag, 0, frag.Length);
                }
                
                _lastCompletedFrameId = header.FrameId;
                OnFrameReceived?.Invoke(ms.ToArray(), header.PacketType);
            }
        }
        
        // Note: In a real implementation, we'd need a timer to clean up incomplete frames in _pendingFrames
    }

    public async Task SendCommandAsync(string cmd)
    {
        if (_tcpStream == null) return;
        var bytes = Encoding.UTF8.GetBytes(cmd + "\n");
        await _tcpStream.WriteAsync(bytes);
    }

    public void Dispose()
    {
        try
        {
            _cts.Cancel();
            _tcpClient?.Close();
            _udpClient?.Close();
        }
        catch {}
    }
}