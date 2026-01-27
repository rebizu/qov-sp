using QovLibrary;

namespace QovValidator;

class Program
{
    static int Main(string[] args)
    {
        Console.WriteLine("QOV File Validator");
        Console.WriteLine("==================");
        Console.WriteLine();

        if (args.Length < 1)
        {
            Console.WriteLine("Usage: QovValidator <qov-file> [options]");
            Console.WriteLine();
            Console.WriteLine("Options:");
            Console.WriteLine("  --verbose, -v    Show detailed chunk information");
            Console.WriteLine("  --decode, -d     Attempt to decode all frames");
            Console.WriteLine("  --hex            Show hex dump of header");
            return 1;
        }

        string filepath = args[0];
        bool verbose = args.Contains("--verbose") || args.Contains("-v");
        bool decode = args.Contains("--decode") || args.Contains("-d");
        bool showHex = args.Contains("--hex");

        if (!File.Exists(filepath))
        {
            Console.WriteLine($"Error: File not found: {filepath}");
            return 1;
        }

        var validator = new QovFileValidator(filepath, verbose, decode, showHex);
        return validator.Validate() ? 0 : 1;
    }
}

class QovFileValidator
{
    private readonly string _filepath;
    private readonly bool _verbose;
    private readonly bool _decode;
    private readonly bool _showHex;
    private readonly List<string> _errors = new();
    private readonly List<string> _warnings = new();
    private int _chunkCount;
    private int _keyframeCount;
    private int _pframeCount;
    private int _syncCount;
    private long _fileSize;
    private byte _version;

    public QovFileValidator(string filepath, bool verbose, bool decode, bool showHex)
    {
        _filepath = filepath;
        _verbose = verbose;
        _decode = decode;
        _showHex = showHex;
    }

    public bool Validate()
    {
        try
        {
            using var stream = File.OpenRead(_filepath);
            _fileSize = stream.Length;

            Console.WriteLine($"File: {Path.GetFileName(_filepath)}");
            Console.WriteLine($"Size: {_fileSize:N0} bytes");
            Console.WriteLine();

            // Validate header
            if (!ValidateHeader(stream))
            {
                PrintResults();
                return false;
            }

            // Validate chunks
            ValidateChunks(stream);

            // Optionally decode frames
            if (_decode && _errors.Count == 0)
            {
                DecodeFrames();
            }

            PrintResults();
            return _errors.Count == 0;
        }
        catch (Exception ex)
        {
            _errors.Add($"Exception: {ex.Message}");
            PrintResults();
            return false;
        }
    }

    private bool ValidateHeader(FileStream stream)
    {
        Console.WriteLine("=== Header Validation ===");

        if (_fileSize < 24)
        {
            _errors.Add($"File too small for header (expected >= 24 bytes, got {_fileSize})");
            return false;
        }

        var header = new byte[24];
        stream.Read(header, 0, 24);

        if (_showHex)
        {
            Console.WriteLine("Header hex dump:");
            for (int i = 0; i < 24; i += 8)
            {
                Console.Write($"  {i:D2}: ");
                for (int j = 0; j < 8 && i + j < 24; j++)
                {
                    Console.Write($"{header[i + j]:X2} ");
                }
                Console.Write("  ");
                for (int j = 0; j < 8 && i + j < 24; j++)
                {
                    char c = (char)header[i + j];
                    Console.Write(char.IsControl(c) ? '.' : c);
                }
                Console.WriteLine();
            }
            Console.WriteLine();
        }

        // Magic bytes
        string magic = System.Text.Encoding.ASCII.GetString(header, 0, 4);
        if (magic != "qovf")
        {
            _errors.Add($"Invalid magic bytes: expected 'qovf', got '{magic}'");
            return false;
        }
        Console.WriteLine($"  Magic: qovf [OK]");

        // Version
        _version = header[4];
        if (_version != 0x01 && _version != 0x02)
        {
            _errors.Add($"Invalid version: expected 0x01 or 0x02, got 0x{_version:X2}");
        }
        else
        {
            Console.WriteLine($"  Version: 0x{_version:X2} ({(_version == 1 ? "16-bit chunks" : "32-bit chunks")}) [OK]");
        }

        // Flags
        byte flags = header[5];
        var flagNames = new List<string>();
        if ((flags & 0x01) != 0) flagNames.Add("HAS_ALPHA");
        if ((flags & 0x02) != 0) flagNames.Add("HAS_MOTION");
        if ((flags & 0x04) != 0) flagNames.Add("HAS_INDEX");
        if ((flags & 0x08) != 0) flagNames.Add("HAS_BFRAMES");
        if ((flags & 0x10) != 0) flagNames.Add("ENHANCED_COMP");
        if ((flags & 0xE0) != 0) _warnings.Add($"Reserved flag bits set: 0x{(flags & 0xE0):X2}");
        string flagStr = flagNames.Count > 0 ? string.Join(", ", flagNames) : "none";
        Console.WriteLine($"  Flags: 0x{flags:X2} [{flagStr}]");

        // Width/Height (big-endian)
        ushort width = ReadU16BE(header, 6);
        ushort height = ReadU16BE(header, 8);
        if (width == 0) _errors.Add("Width is 0");
        if (height == 0) _errors.Add("Height is 0");
        Console.WriteLine($"  Resolution: {width}x{height}");

        // Frame rate (big-endian)
        ushort fpsNum = ReadU16BE(header, 10);
        ushort fpsDen = ReadU16BE(header, 12);
        if (fpsDen == 0)
        {
            _errors.Add("Frame rate denominator is 0");
        }
        else
        {
            double fps = (double)fpsNum / fpsDen;
            Console.WriteLine($"  Frame rate: {fpsNum}/{fpsDen} ({fps:F2} fps)");
        }

        // Total frames (big-endian)
        uint totalFrames = ReadU32BE(header, 14);
        Console.WriteLine($"  Total frames: {totalFrames}");

        // Audio
        byte audioChannels = header[18];
        uint audioRate = ((uint)header[19] << 16) | ((uint)header[20] << 8) | header[21];
        if (audioChannels > 0)
        {
            Console.WriteLine($"  Audio: {audioChannels} channels @ {audioRate} Hz");
        }
        else
        {
            Console.WriteLine($"  Audio: None");
        }

        // Colorspace
        byte colorspace = header[22];
        string csName = colorspace switch
        {
            0x00 => "SRGB",
            0x01 => "SRGBA",
            0x02 => "LINEAR",
            0x03 => "LINEAR_A",
            0x10 => "YUV420",
            0x11 => "YUV422",
            0x12 => "YUV444",
            0x13 => "YUVA420",
            _ => $"UNKNOWN(0x{colorspace:X2})"
        };
        if (colorspace > 0x13 && colorspace != 0x00)
        {
            _warnings.Add($"Unknown colorspace: 0x{colorspace:X2}");
        }
        Console.WriteLine($"  Colorspace: {csName}");

        // Reserved byte
        byte reserved = header[23];
        if (reserved != 0)
        {
            _warnings.Add($"Reserved byte is non-zero: 0x{reserved:X2}");
        }

        Console.WriteLine();
        return true;
    }

    private void ValidateChunks(FileStream stream)
    {
        Console.WriteLine("=== Chunk Validation ===");

        int chunkHeaderSize = _version == 0x02 ? 10 : 8;

        stream.Position = 24; // After file header

        bool foundEnd = false;
        bool foundIndex = false;
        long lastKeyframeOffset = -1;
        uint lastTimestamp = 0;

        while (stream.Position < _fileSize)
        {
            long chunkStart = stream.Position;

            if (_fileSize - stream.Position < chunkHeaderSize)
            {
                _errors.Add($"Truncated chunk header at offset 0x{chunkStart:X}");
                break;
            }

            var chunkHeader = new byte[chunkHeaderSize];
            stream.Read(chunkHeader, 0, chunkHeaderSize);

            byte chunkType = chunkHeader[0];
            byte chunkFlags = chunkHeader[1];
            uint chunkSize, timestamp;

            if (_version == 0x02)
            {
                chunkSize = ReadU32BE(chunkHeader, 2);
                timestamp = ReadU32BE(chunkHeader, 6);
            }
            else
            {
                chunkSize = ReadU16BE(chunkHeader, 2);
                timestamp = ReadU32BE(chunkHeader, 4);
            }

            _chunkCount++;

            string typeName = chunkType switch
            {
                0x00 => "SYNC",
                0x01 => "KEYFRAME",
                0x02 => "PFRAME",
                0x03 => "BFRAME",
                0x10 => "AUDIO",
                0xF0 => "INDEX",
                0xFF => "END",
                _ => $"UNKNOWN(0x{chunkType:X2})"
            };

            if (_verbose)
            {
                Console.WriteLine($"  [0x{chunkStart:X8}] {typeName,-10} flags=0x{chunkFlags:X2} size={chunkSize,8} ts={timestamp,10}");
            }

            // Check chunk doesn't extend past file
            long chunkEnd = chunkStart + chunkHeaderSize + chunkSize;
            if (chunkEnd > _fileSize && chunkType != 0xFF)
            {
                _errors.Add($"Chunk at 0x{chunkStart:X} extends past end of file (ends at 0x{chunkEnd:X}, file size 0x{_fileSize:X})");
                break;
            }

            // Validate chunk-specific rules
            switch (chunkType)
            {
                case 0x00: // SYNC
                    _syncCount++;
                    ValidateSyncChunk(stream, chunkStart, chunkSize, chunkHeaderSize);
                    break;

                case 0x01: // KEYFRAME
                    _keyframeCount++;
                    lastKeyframeOffset = chunkStart;
                    ValidateFrameChunk(stream, chunkStart, chunkSize, chunkFlags, chunkHeaderSize, true);
                    break;

                case 0x02: // PFRAME
                    _pframeCount++;
                    if (lastKeyframeOffset < 0)
                    {
                        _errors.Add($"P-frame at 0x{chunkStart:X} before any keyframe");
                    }
                    ValidateFrameChunk(stream, chunkStart, chunkSize, chunkFlags, chunkHeaderSize, false);
                    break;

                case 0x03: // BFRAME
                    _warnings.Add($"B-frame at 0x{chunkStart:X} (B-frames not commonly used)");
                    stream.Position = chunkStart + chunkHeaderSize + chunkSize;
                    break;

                case 0x10: // AUDIO
                    stream.Position = chunkStart + chunkHeaderSize + chunkSize;
                    break;

                case 0xF0: // INDEX
                    foundIndex = true;
                    ValidateIndexChunk(stream, chunkStart, chunkSize, chunkHeaderSize);
                    break;

                case 0xFF: // END
                    foundEnd = true;
                    ValidateEndChunk(stream, chunkStart, chunkSize, chunkHeaderSize);
                    break;

                default:
                    _warnings.Add($"Unknown chunk type 0x{chunkType:X2} at 0x{chunkStart:X}");
                    stream.Position = chunkStart + chunkHeaderSize + chunkSize;
                    break;
            }

            if (timestamp < lastTimestamp && chunkType != 0xF0 && chunkType != 0xFF && chunkType != 0x00)
            {
                _warnings.Add($"Timestamp decreased at chunk 0x{chunkStart:X}: {lastTimestamp} -> {timestamp}");
            }
            if (chunkType != 0xF0 && chunkType != 0xFF)
            {
                lastTimestamp = timestamp;
            }

            if (foundEnd) break;
        }

        if (!foundEnd)
        {
            _errors.Add("No END marker found");
        }

        Console.WriteLine();
        Console.WriteLine($"  Total chunks: {_chunkCount}");
        Console.WriteLine($"  SYNC markers: {_syncCount}");
        Console.WriteLine($"  Keyframes: {_keyframeCount}");
        Console.WriteLine($"  P-frames: {_pframeCount}");
        Console.WriteLine($"  Has index: {(foundIndex ? "Yes" : "No")}");
        Console.WriteLine();
    }

    private void ValidateSyncChunk(FileStream stream, long chunkStart, uint chunkSize, int headerSize)
    {
        if (chunkSize != 8)
        {
            _warnings.Add($"SYNC chunk at 0x{chunkStart:X} has unexpected size {chunkSize} (expected 8)");
        }

        long dataStart = chunkStart + headerSize;
        stream.Position = dataStart;

        if (chunkSize >= 8)
        {
            var syncData = new byte[8];
            stream.Read(syncData, 0, 8);
            string syncMagic = System.Text.Encoding.ASCII.GetString(syncData, 0, 4);
            if (syncMagic != "QOVS")
            {
                _errors.Add($"SYNC chunk at 0x{chunkStart:X} has invalid magic: '{syncMagic}' (expected 'QOVS')");
            }
            uint frameNum = ReadU32BE(syncData, 4);
            if (_verbose)
            {
                Console.WriteLine($"    SYNC magic: {syncMagic}, frame: {frameNum}");
            }
        }

        stream.Position = dataStart + chunkSize;
    }

    private void ValidateFrameChunk(FileStream stream, long chunkStart, uint chunkSize, byte flags, int headerSize, bool isKeyframe)
    {
        long dataStart = chunkStart + headerSize;
        long dataEnd = dataStart + chunkSize;

        stream.Position = dataStart;

        bool isCompressed = (flags & 0x10) != 0;
        bool isYuv = (flags & 0x01) != 0;

        if (_verbose)
        {
            Console.WriteLine($"    Compressed: {isCompressed}, YUV: {isYuv}");
        }

        if (isCompressed && chunkSize >= 4)
        {
            var sizeBytes = new byte[4];
            stream.Read(sizeBytes, 0, 4);
            uint uncompressedSize = ReadU32BE(sizeBytes, 0);
            if (_verbose)
            {
                Console.WriteLine($"    Uncompressed size: {uncompressedSize}");
            }

            // Sanity check uncompressed size
            if (uncompressedSize > 100_000_000)
            {
                _warnings.Add($"Frame at 0x{chunkStart:X} has very large uncompressed size: {uncompressedSize}");
            }
        }

        stream.Position = dataEnd;
    }

    private void ValidateIndexChunk(FileStream stream, long chunkStart, uint chunkSize, int headerSize)
    {
        long dataStart = chunkStart + headerSize;
        stream.Position = dataStart;

        if (chunkSize < 4)
        {
            _errors.Add($"INDEX chunk at 0x{chunkStart:X} too small (size={chunkSize})");
            return;
        }

        var countBytes = new byte[4];
        stream.Read(countBytes, 0, 4);
        uint entryCount = ReadU32BE(countBytes, 0);

        uint expectedSize = 4 + entryCount * 16;
        if (chunkSize != expectedSize)
        {
            _warnings.Add($"INDEX chunk size mismatch: expected {expectedSize}, got {chunkSize}");
        }

        if (_verbose)
        {
            Console.WriteLine($"    Index entries: {entryCount}");
        }

        // Validate each entry
        for (uint i = 0; i < entryCount && stream.Position + 16 <= dataStart + chunkSize; i++)
        {
            var entry = new byte[16];
            stream.Read(entry, 0, 16);

            uint frameNum = ReadU32BE(entry, 0);
            ulong offset = ((ulong)ReadU32BE(entry, 4) << 32) | ReadU32BE(entry, 8);
            uint timestamp = ReadU32BE(entry, 12);

            if (_verbose)
            {
                Console.WriteLine($"      [{i}] frame={frameNum} offset=0x{offset:X} ts={timestamp}");
            }

            if (offset >= (ulong)_fileSize)
            {
                _errors.Add($"Index entry {i} has invalid offset 0x{offset:X} (file size: 0x{_fileSize:X})");
            }
        }

        stream.Position = dataStart + chunkSize;
    }

    private void ValidateEndChunk(FileStream stream, long chunkStart, uint chunkSize, int headerSize)
    {
        if (chunkSize != 0)
        {
            _warnings.Add($"END chunk has non-zero size: {chunkSize}");
        }

        long dataStart = chunkStart + headerSize;
        stream.Position = dataStart;

        // Check for end pattern after header
        if (_fileSize - stream.Position >= 8)
        {
            var endPattern = new byte[8];
            stream.Read(endPattern, 0, 8);

            bool validPattern = true;
            for (int i = 0; i < 7; i++)
            {
                if (endPattern[i] != 0) validPattern = false;
            }
            if (endPattern[7] != 1) validPattern = false;

            if (!validPattern)
            {
                _errors.Add("Invalid END pattern (expected 00 00 00 00 00 00 00 01)");
                Console.Write("    Got: ");
                foreach (var b in endPattern) Console.Write($"{b:X2} ");
                Console.WriteLine();
            }
            else if (_verbose)
            {
                Console.WriteLine("    End pattern: [OK]");
            }
        }
        else
        {
            _errors.Add("END chunk missing end pattern (file truncated)");
        }
    }

    private void DecodeFrames()
    {
        Console.WriteLine("=== Decode Validation ===");

        try
        {
            using var stream = File.OpenRead(_filepath);
            var decoder = new QovDecoder(stream);

            var header = decoder.DecodeHeader();
            Console.WriteLine($"  Header decoded: {header.Width}x{header.Height}");

            int frameCount = 0;
            int keyframes = 0;
            int pframes = 0;

            foreach (var frame in decoder.DecodeFrames())
            {
                frameCount++;
                if (frame.IsKeyframe) keyframes++;
                else pframes++;

                // Validate pixel data
                int expectedPixels = (int)(header.Width * header.Height);
                int actualPixels = frame.Pixels.Length / 4;

                if (actualPixels != expectedPixels)
                {
                    _errors.Add($"Frame {frameCount} has wrong pixel count: expected {expectedPixels}, got {actualPixels}");
                }
            }

            Console.WriteLine($"  Successfully decoded {frameCount} frames ({keyframes} key, {pframes} P)");
            Console.WriteLine();
        }
        catch (Exception ex)
        {
            _errors.Add($"Decode failed: {ex.Message}");
        }
    }

    private void PrintResults()
    {
        Console.WriteLine("=== Validation Results ===");

        if (_warnings.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine($"Warnings ({_warnings.Count}):");
            foreach (var warning in _warnings)
            {
                Console.WriteLine($"  [WARN] {warning}");
            }
        }

        if (_errors.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine($"Errors ({_errors.Count}):");
            foreach (var error in _errors)
            {
                Console.WriteLine($"  [ERROR] {error}");
            }
        }

        Console.WriteLine();
        if (_errors.Count == 0)
        {
            Console.WriteLine("VALIDATION PASSED");
        }
        else
        {
            Console.WriteLine("VALIDATION FAILED");
        }
    }

    private static ushort ReadU16BE(byte[] data, int offset)
    {
        return (ushort)((data[offset] << 8) | data[offset + 1]);
    }

    private static uint ReadU32BE(byte[] data, int offset)
    {
        return ((uint)data[offset] << 24) |
               ((uint)data[offset + 1] << 16) |
               ((uint)data[offset + 2] << 8) |
               data[offset + 3];
    }
}
