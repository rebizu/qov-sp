namespace QovLibrary;

/// <summary>
/// QOV (Quite OK Video) format types and constants.
/// Based on QOV specification version 1.0.
/// </summary>
public static partial class QovTypes
{
    public const string Magic = "qovf";
    public const byte Version1 = 0x01;
    public const byte Version2 = 0x02;

    public const byte FlagHasAlpha = 0x01;
    public const byte FlagHasMotion = 0x02;
    public const byte FlagHasIndex = 0x04;
    public const byte FlagHasBFrames = 0x08;
    public const byte FlagEnhancedComp = 0x10;

    public const byte ChunkFlagYuv = 0x01;
    public const byte ChunkFlagMotion = 0x02;
    public const byte ChunkFlagCompressed = 0x10;

    public const byte ChunkTypeSync = 0x00;
    public const byte ChunkTypeKeyframe = 0x01;
    public const byte ChunkTypePframe = 0x02;
    public const byte ChunkTypeBframe = 0x03;
    public const byte ChunkTypeAudio = 0x10;
    public const byte ChunkTypeIndex = 0xF0;
    public const byte ChunkTypeEnd = 0xFF;

    public const byte ColorspaceSrgb = 0x00;
    public const byte ColorspaceSrgba = 0x01;
    public const byte ColorspaceLinear = 0x02;
    public const byte ColorspaceLinearA = 0x03;
    public const byte ColorspaceYuv420 = 0x10;
    public const byte ColorspaceYuv422 = 0x11;
    public const byte ColorspaceYuv444 = 0x12;
    public const byte ColorspaceYuva420 = 0x13;

    public const byte RunMaxCount = 62;
    public const byte SkipMaxCount = 62;

    public static string GetChunkTypeName(byte chunkType) => chunkType switch
    {
        ChunkTypeSync => "SYNC",
        ChunkTypeKeyframe => "KEYFRAME",
        ChunkTypePframe => "PFRAME",
        ChunkTypeBframe => "BFRAME",
        ChunkTypeAudio => "AUDIO",
        ChunkTypeIndex => "INDEX",
        ChunkTypeEnd => "END",
        _ => $"UNKNOWN(0x{chunkType:X2})"
    };
}

public readonly struct QovHeader
{
    public string Magic { get; init; }
    public byte Version { get; init; }
    public byte Flags { get; init; }
    public ushort Width { get; init; }
    public ushort Height { get; init; }
    public ushort FrameRateNum { get; init; }
    public ushort FrameRateDen { get; init; }
    public uint TotalFrames { get; init; }
    public byte AudioChannels { get; init; }
    public uint AudioRate { get; init; }
    public byte Colorspace { get; init; }

    public QovHeader(byte flags, ushort width, ushort height, ushort frameRateNum = 30, ushort frameRateDen = 1,
        byte colorspace = QovTypes.ColorspaceSrgb, byte audioChannels = 0, uint audioRate = 0,uint totalFrames=0)
    {
        Magic = QovTypes.Magic;
        Version = QovTypes.Version2;
        Flags = flags;
        Width = width;
        Height = height;
        FrameRateNum = frameRateNum;
        FrameRateDen = frameRateDen;
        TotalFrames = totalFrames;
        AudioChannels = audioChannels;
        AudioRate = audioRate;
        Colorspace = colorspace;
    }
}

public readonly struct QovChunk
{
    public byte ChunkType { get; init; }
    public byte ChunkFlags { get; init; }
    public uint ChunkSize { get; init; }
    public uint Timestamp { get; init; }
    public uint? UncompressedSize { get; init; }
}

public struct QovPixel
{
    public readonly byte R;
    public readonly byte G;
    public readonly byte B;
    public readonly byte A;

    public QovPixel(byte r, byte g, byte b, byte a = 255)
    {
        R = r;
        G = g;
        B = b;
        A = a;
    }

    public static bool Equals(in QovPixel a, in QovPixel b) =>
        a.R == b.R && a.G == b.G && a.B == b.B && a.A == b.A;

    public override bool Equals(object? obj) =>
        obj is QovPixel p && Equals(in this, in p);

    public override int GetHashCode() =>
        HashCode.Combine(R, G, B, A);

    public static QovPixel operator -(in QovPixel a, in QovPixel b) =>
        new((byte)((sbyte)a.R - (sbyte)b.R), (byte)((sbyte)a.G - (sbyte)b.G), (byte)((sbyte)a.B - (sbyte)b.B), a.A);

    public static QovPixel operator +(in QovPixel a, in QovPixel b) =>
        new((byte)a.R, (byte)a.G, (byte)a.B, a.A);
}

public readonly struct QovIndexEntry
{
    public uint FrameNumber { get; init; }
    public ulong FileOffset { get; init; }
    public uint Timestamp { get; init; }
}

public struct QovFrameStats
{
    public QovHeader Header;
    public ulong FileSize;
    public int FramesDecoded;
    public uint LastTimestamp;
}

public class QovException : Exception
{
    public QovException(string message) : base(message) { }
    public QovException(string message, Exception inner) : base(message, inner) { }
}