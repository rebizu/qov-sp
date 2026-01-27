namespace QovLibrary;

/// <summary>
/// QOV Encoder - encodes RGBA frames to QOV format with temporal compression.
/// </summary>
public class QovEncoder
{
    private readonly BinaryWriter _writer;
    private readonly QovHeader _header;
    private readonly byte[] _prevFrame;
    private readonly QovPixel[] _colorIndex;
    private readonly QovPixel[] _colorCache;
    private QovPixel _prevPixel;
    private readonly List<QovIndexEntry> _keyframes;
    private int _frameCount;
    private readonly bool _isYuvMode;
    private readonly bool _useCompression;

    public QovEncoder(Stream output, ushort width, ushort height,
        ushort frameRateNum = 30, ushort frameRateDen = 1,
        byte flags = QovTypes.FlagHasIndex,
        byte colorspace = QovTypes.ColorspaceSrgb,
        bool useCompression = true)
    {
        _writer = new BinaryWriter(output, System.Text.Encoding.ASCII, leaveOpen: true);
        _header = new QovHeader(flags, width, height, frameRateNum, frameRateDen, colorspace);
        _prevFrame = new byte[width * height * 4];
        _colorIndex = new QovPixel[64];
        _colorCache = new QovPixel[64];
        _prevPixel = new QovPixel(0, 0, 0, 255);
        _keyframes = new List<QovIndexEntry>();
        _useCompression = useCompression;

        _isYuvMode = colorspace >= QovTypes.ColorspaceYuv420;

        WriteHeader();
    }

    private void WriteHeader()
    {
        // Magic "qovf"
        _writer.Write((byte)0x71); // 'q'
        _writer.Write((byte)0x6f); // 'o'
        _writer.Write((byte)0x76); // 'v'
        _writer.Write((byte)0x66); // 'f'

        // Version
        _writer.Write(QovTypes.Version2);

        // Flags
        _writer.Write(_header.Flags);

        // Dimensions (big-endian)
        WriteBigEndian(_header.Width);
        WriteBigEndian(_header.Height);

        // Frame rate (big-endian)
        WriteBigEndian(_header.FrameRateNum);
        WriteBigEndian(_header.FrameRateDen);

        // Total frames (big-endian, placeholder - updated later)
        WriteBigEndian(_header.TotalFrames);

        // Audio fields - explicitly write 0 to avoid struct issues
        _writer.Write((byte)0);      // audio_channels (0 = no audio)
        _writer.Write((byte)0);      // audio_rate byte 1
        _writer.Write((byte)0);      // audio_rate byte 2
        _writer.Write((byte)0);      // audio_rate byte 3

        // Colorspace and reserved
        _writer.Write(_header.Colorspace);
        _writer.Write((byte)0); // reserved
    }

    public void EncodeKeyframe(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        if (_isYuvMode)
        {
            EncodeYuvKeyframe(pixels, timestamp);
        }
        else
        {
            EncodeRgbKeyframe(pixels, timestamp);
        }
        
        // Update previous frame buffer
        pixels.CopyTo(_prevFrame);
    }

    private void EncodeRgbKeyframe(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        int frameNumber = _frameCount++;
        int pixelCount = _header.Width * _header.Height;

        if ((_header.Flags & QovTypes.FlagHasIndex) != 0)
        {
            _keyframes.Add(new QovIndexEntry
            {
                FrameNumber = (uint)frameNumber,
                FileOffset = (ulong)_writer.BaseStream.Position,
                Timestamp = timestamp
            });
        }

        WriteSync(frameNumber, timestamp);

        Array.Clear(_colorIndex, 0, 64);
        Array.Clear(_colorCache, 0, 64);
        _prevPixel = new QovPixel(0, 0, 0, 255);

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);

        int runCount = 0;
        QovPixel prevPixel = new QovPixel(0, 0, 0, 255);

        for (int px = 0; px < pixelCount; px++)
        {
            int idx = px * 4;
            QovPixel current = new QovPixel(pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]);

            // Check for run-length encoding
            if (QovPixel.Equals(current, prevPixel))
            {
                runCount++;
                // If we reach max run length or at end of image, write the run
                if (runCount == QovTypes.RunMaxCount || px == pixelCount - 1)
                {
                    tempWriter.Write((byte)(0xC0 | (runCount - 1)));
                    runCount = 0;
                }
                // Continue to next pixel without encoding
                continue;
            }

            // If we had a run, write it now
            if (runCount > 0)
            {
                tempWriter.Write((byte)(0xC0 | (runCount - 1)));
                runCount = 0;
            }

            // Encode the current pixel
            int hash = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;

            if (QovPixel.Equals(_colorCache[hash], current))
            {
                tempWriter.Write((byte)hash);
            }
            else
            {
                int dr = current.R - prevPixel.R;
                int dg = current.G - prevPixel.G;
                int db = current.B - prevPixel.B;
                int da = current.A - prevPixel.A;

                if (da == 0)
                {
                    if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1)
                    {
                        tempWriter.Write((byte)(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)));
                    }
                    else if (dg >= -32 && dg <= 31)
                    {
                        int drDg = dr - dg;
                        int dbDg = db - dg;
                        if (drDg >= -8 && drDg <= 7 && dbDg >= -8 && dbDg <= 7)
                        {
                            tempWriter.Write((byte)(0x80 | (dg + 32)));
                            tempWriter.Write((byte)(((drDg + 8) << 4) | (dbDg + 8)));
                        }
                        else
                        {
                            tempWriter.Write((byte)0xFE);
                            tempWriter.Write(current.R);
                            tempWriter.Write(current.G);
                            tempWriter.Write(current.B);
                        }
                    }
                    else
                    {
                        tempWriter.Write((byte)0xFE);
                        tempWriter.Write(current.R);
                        tempWriter.Write(current.G);
                        tempWriter.Write(current.B);
                    }
                }
                else
                {
                    tempWriter.Write((byte)0xFF);
                    tempWriter.Write(current.R);
                    tempWriter.Write(current.G);
                    tempWriter.Write(current.B);
                    tempWriter.Write(current.A);
                }

                _colorCache[hash] = current;
            }

            prevPixel = current;
        }

        // Write end marker
        for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
        tempWriter.Write((byte)1);

        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypeKeyframe, 0, timestamp, frameData, true);
    }

    private void EncodeYuvKeyframe(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        int frameNumber = _frameCount++;
        int pixelCount = _header.Width * _header.Height;

        if ((_header.Flags & QovTypes.FlagHasIndex) != 0)
        {
            _keyframes.Add(new QovIndexEntry
            {
                FrameNumber = (uint)frameNumber,
                FileOffset = (ulong)_writer.BaseStream.Position,
                Timestamp = timestamp
            });
        }

        WriteSync(frameNumber, timestamp);

        ColorConversion.RgbaToYuv420(pixels, _header.Width, _header.Height,
            out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);

        EncodeYuvPlane(yPlane, tempWriter);
        EncodeYuvPlane(uPlane, tempWriter);
        EncodeYuvPlane(vPlane, tempWriter);

        // Write end marker
        for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
        tempWriter.Write((byte)1);

        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypeKeyframe, QovTypes.ChunkFlagYuv, timestamp, frameData, true);
    }

    public void EncodePFrame(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        if (_prevFrame.All(b => b == 0))
        {
            EncodeKeyframe(pixels, timestamp);
            // Update previous frame buffer after encoding keyframe
            pixels.CopyTo(_prevFrame);
            return;
        }

        if (_isYuvMode)
        {
            EncodeYuvPFrame(pixels, timestamp);
        }
        else
        {
            EncodeRgbPFrame(pixels, timestamp);
        }
        
        // Update previous frame buffer
        pixels.CopyTo(_prevFrame);
    }

    private void EncodeRgbPFrame(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        _frameCount++;
        int pixelCount = _header.Width * _header.Height;

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);

        int skipCount = 0;
        QovPixel prevPixel = new QovPixel(0, 0, 0, 255);

        for (int px = 0; px < pixelCount; px++)
        {
            int idx = px * 4;
            int prevIdx = idx;
            QovPixel current = new QovPixel(pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]);
            QovPixel prev = new QovPixel(_prevFrame[prevIdx], _prevFrame[prevIdx + 1], _prevFrame[prevIdx + 2], _prevFrame[prevIdx + 3]);

            // Check if pixel unchanged from reference
            if (QovPixel.Equals(current, prev))
            {
                skipCount++;
                // If we reach max skip count or at end, write the skip
                if (skipCount == QovTypes.SkipMaxCount || px == pixelCount - 1)
                {
                    if (skipCount <= QovTypes.SkipMaxCount)
                    {
                        tempWriter.Write((byte)(0xC0 | (skipCount - 1)));
                    }
                    else
                    {
                        // Write long skip
                        tempWriter.Write((byte)0x00);
                        tempWriter.Write((ushort)skipCount);
                    }
                    skipCount = 0;
                }
                continue;
            }

            // If we had a skip, write it now
            if (skipCount > 0)
            {
                if (skipCount <= QovTypes.SkipMaxCount)
                {
                    tempWriter.Write((byte)(0xC0 | (skipCount - 1)));
                }
                else
                {
                    // Write long skip
                    tempWriter.Write((byte)0x00);
                    tempWriter.Write((ushort)skipCount);
                }
                skipCount = 0;
            }

            // Try temporal diff
            int dr = current.R - prev.R;
            int dg = current.G - prev.G;
            int db = current.B - prev.B;
            int da = current.A - prev.A;

            if (da == 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1)
            {
                tempWriter.Write((byte)(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)));
                int hash = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;
                _colorCache[hash] = current;
            }
            else if (da == 0 && dg >= -32 && dg <= 31)
            {
                int drDg = dr - dg;
                int dbDg = db - dg;
                if (drDg >= -8 && drDg <= 7 && dbDg >= -8 && dbDg <= 7)
                {
                    tempWriter.Write((byte)(0x80 | (dg + 32)));
                    tempWriter.Write((byte)(((drDg + 8) << 4) | (dbDg + 8)));
                    int hash = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;
                    _colorCache[hash] = current;
                }
                else
                {
                    tempWriter.Write((byte)0xFE);
                    tempWriter.Write(current.R);
                    tempWriter.Write(current.G);
                    tempWriter.Write(current.B);
                }
            }
            else if (da == 0)
            {
                tempWriter.Write((byte)0xFE);
                tempWriter.Write(current.R);
                tempWriter.Write(current.G);
                tempWriter.Write(current.B);
            }
            else
            {
                tempWriter.Write((byte)0xFF);
                tempWriter.Write(current.R);
                tempWriter.Write(current.G);
                tempWriter.Write(current.B);
                tempWriter.Write(current.A);
            }
        }

        // Write end marker
        for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
        tempWriter.Write((byte)1);

        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypePframe, 0, timestamp, frameData, false);
    }

    private void EncodeYuvPFrame(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        _frameCount++;

        ColorConversion.RgbaToYuv420(pixels, _header.Width, _header.Height,
            out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        ColorConversion.RgbaToYuv420(_prevFrame, _header.Width, _header.Height,
            out byte[] prevY, out byte[] prevU, out byte[] prevV);

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);

        EncodeYuvPlaneTemporal(yPlane, prevY, tempWriter);
        EncodeYuvPlaneTemporal(uPlane, prevU, tempWriter);
        EncodeYuvPlaneTemporal(vPlane, prevV, tempWriter);

        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypePframe, QovTypes.ChunkFlagYuv, timestamp, frameData, false);
    }

private void EncodeRgbPixel(in QovPixel current, BinaryWriter writer)
    {
        int hash = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;

        if (QovPixel.Equals(current, _prevPixel))
        {
            // Handle run-length encoding properly in the calling function
            // This function should only encode a single pixel
            int idx = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;
            if (QovPixel.Equals(_colorCache[idx], current))
            {
                writer.Write((byte)idx);
            }
            else
            {
                writer.Write((byte)0xFE); // Use RGB as fallback
                writer.Write(current.R);
                writer.Write(current.G);
                writer.Write(current.B);
                writer.Write(current.A);
                _colorCache[idx] = current;
            }
            _prevPixel = current;
            return;
        }

        if (QovPixel.Equals(_colorCache[hash], current))
        {
            writer.Write((byte)hash);
        }
        else
        {
            int dr = current.R - _prevPixel.R;
            int dg = current.G - _prevPixel.G;
            int db = current.B - _prevPixel.B;
            int da = current.A - _prevPixel.A;

            if (da == 0)
            {
                if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1)
                {
                    writer.Write((byte)(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)));
                }
                else if (dg >= -32 && dg <= 31)
                {
                    int drDg = dr - dg;
                    int dbDg = db - dg;
                    if (drDg >= -8 && drDg <= 7 && dbDg >= -8 && dbDg <= 7)
                    {
                        writer.Write((byte)(0x80 | (dg + 32)));
                        writer.Write((byte)(((drDg + 8) << 4) | (dbDg + 8)));
                    }
                    else
                    {
                        writer.Write((byte)0xFE);
                        writer.Write(current.R);
                        writer.Write(current.G);
                        writer.Write(current.B);
                    }
                }
                else
                {
                    writer.Write((byte)0xFE);
                    writer.Write(current.R);
                    writer.Write(current.G);
                    writer.Write(current.B);
                }
            }
            else
            {
                writer.Write((byte)0xFF);
                writer.Write(current.R);
                writer.Write(current.G);
                writer.Write(current.B);
                writer.Write(current.A);
            }

            _colorCache[hash] = current;
        }

        _prevPixel = current;
    }

    private void EncodeRgbTempPixel(in QovPixel current, in QovPixel prev, BinaryWriter writer)
    {
        int skipCount = 0;
        
        if (QovPixel.Equals(current, prev))
        {
            SkipPixel(writer, ref skipCount);
            return;
        }

        int dr = current.R - prev.R;
        int dg = current.G - prev.G;
        int db = current.B - prev.B;
        int da = current.A - prev.A;

        if (da == 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1)
        {
            writer.Write((byte)(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)));
            int hash = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;
            _colorCache[hash] = current;
        }
        else if (da == 0 && dg >= -32 && dg <= 31)
        {
            int drDg = dr - dg;
            int dbDg = db - dg;
            if (drDg >= -8 && drDg <= 7 && dbDg >= -8 && dbDg <= 7)
            {
                writer.Write((byte)(0x80 | (dg + 32)));
                writer.Write((byte)(((drDg + 8) << 4) | (dbDg + 8)));
                int hash = (current.R * 3 + current.G * 5 + current.B * 7 + current.A * 11) % 64;
                _colorCache[hash] = current;
            }
            else
            {
                writer.Write((byte)0xFE);
                writer.Write(current.R);
                writer.Write(current.G);
                writer.Write(current.B);
            }
        }
        else if (da == 0)
        {
            writer.Write((byte)0xFE);
            writer.Write(current.R);
            writer.Write(current.G);
            writer.Write(current.B);
        }
        else
        {
            writer.Write((byte)0xFF);
            writer.Write(current.R);
            writer.Write(current.G);
            writer.Write(current.B);
            writer.Write(current.A);
        }
    }

    private void EncodeYuvPlane(ReadOnlySpan<byte> plane, BinaryWriter writer)
    {
        int size = plane.Length;
        byte prevVal = 0;
        int[] index = new int[64];
        Array.Fill(index, 0);
        int px = 0;
        int run = 0;

        while (px < size)
        {
            byte val = plane[px];

            // Check for run
            if (val == prevVal)
            {
                run++;
                if (run == QovTypes.RunMaxCount || px == size - 1)
                {
                    writer.Write((byte)(0xC0 | (run - 1)));
                    run = 0;
                }
                px++;
                continue;
            }

            // Flush pending run
            if (run > 0)
            {
                writer.Write((byte)(0xC0 | (run - 1)));
                run = 0;
            }

            int idx = (val * 3) % 64;
            if (index[idx] == val && px > 0)
            {
                writer.Write((byte)idx);
            }
            else
            {
                int d = val - prevVal;
                if (d >= -8 && d <= 7)
                {
                    writer.Write((byte)(0x40 | (d + 8)));
                }
                else if (d >= -32 && d <= 31)
                {
                    writer.Write((byte)(0x80 | (d + 32)));
                }
                else
                {
                    writer.Write((byte)0xFE);
                    writer.Write(val);
                }
                index[idx] = val;
            }

            prevVal = val;
            px++;
        }

        // Flush final run
        if (run > 0)
        {
            writer.Write((byte)(0xC0 | (run - 1)));
        }
    }

    private void EncodeYuvPlaneTemporal(ReadOnlySpan<byte> plane, ReadOnlySpan<byte> prevPlane, BinaryWriter writer)
    {
        int size = plane.Length;
        int[] index = new int[64];
        Array.Fill(index, 0);
        int px = 0;
        int skip = 0;

        while (px < size)
        {
            // Check for skip (unchanged pixels)
            if (plane[px] == prevPlane[px])
            {
                skip++;
                // If we reach max skip count or at end, write the skip
                if (skip == QovTypes.SkipMaxCount || px == size - 1)
                {
                    writer.Write((byte)(0xC0 | (skip - 1)));
                    skip = 0;
                }
                px++;
                continue;
            }

            // If we had a skip, write it now
            if (skip > 0)
            {
                writer.Write((byte)(0xC0 | (skip - 1)));
                skip = 0;
            }

            byte val = plane[px];
            byte prevVal = prevPlane[px];
            int d = val - prevVal;

            if (d >= -8 && d <= 7)
            {
                writer.Write((byte)(0x40 | (d + 8)));
                int idx = (val * 3) % 64;
                index[idx] = val;
            }
            else if (d >= -32 && d <= 31)
            {
                writer.Write((byte)(0x80 | (d + 32)));
                int idx = (val * 3) % 64;
                index[idx] = val;
            }
            else
            {
                int idx = (val * 3) % 64;
                if (index[idx] == val)
                {
                    writer.Write((byte)idx);
                }
                else
                {
                    writer.Write((byte)0xFE);
                    writer.Write(val);
                    index[idx] = val;
                }
            }

            px++;
        }

        // Flush final skip
        if (skip > 0)
        {
            writer.Write((byte)(0xC0 | (skip - 1)));
        }
    }

    private void SkipPixel(BinaryWriter writer, ref int skipCount)
    {
        if (skipCount > 0)
        {
            if (skipCount <= QovTypes.SkipMaxCount)
            {
                writer.Write((byte)(0xC0 | (skipCount - 1)));
            }
            else
            {
                // Write multiple skip chunks if count exceeds max
                while (skipCount > 0)
                {
                    int chunkSkip = Math.Min(skipCount, QovTypes.SkipMaxCount);
                    writer.Write((byte)(0xC0 | (chunkSkip - 1)));
                    skipCount -= chunkSkip;
                }
            }
            skipCount = 0;
        }
    }

    private void WriteChunk(byte chunkType, byte chunkFlags, uint timestamp, byte[] data, bool isKeyframe)
    {
        long startPos = _writer.BaseStream.Position;

        // Write chunk header (10 bytes for version 0x02)
        _writer.Write(chunkType);                    // 1 byte: chunk_type
        _writer.Write(chunkFlags);                   // 1 byte: chunk_flags
        WriteBigEndian(0u);                          // 4 bytes: chunk_size placeholder (big-endian)
        WriteBigEndian(timestamp);                   // 4 bytes: timestamp (big-endian)

        long dataStartPos = _writer.BaseStream.Position;

        if (_useCompression)
        {
            byte[]? compressed = Lz4Compression.Compress(data);
            if (compressed != null && compressed.Length < data.Length)
            {
                // Compression effective - write compressed data with uncompressed size header
                WriteBigEndian((uint)data.Length);   // 4 bytes: uncompressed size (big-endian)
                _writer.Write(compressed);           // N bytes: compressed data

                // Update chunk flags to indicate compression
                long currentPos = _writer.BaseStream.Position;
                _writer.BaseStream.Seek(startPos + 1, SeekOrigin.Begin);
                _writer.Write((byte)(chunkFlags | QovTypes.ChunkFlagCompressed));
                _writer.BaseStream.Seek(currentPos, SeekOrigin.Begin);
            }
            else
            {
                // Compression not effective, write uncompressed
                _writer.Write(data);
            }
        }
        else
        {
            _writer.Write(data);
        }

        // Update chunk size in header (at offset +2 from start)
        long endPos = _writer.BaseStream.Position;
        long chunkSize = endPos - dataStartPos;

        _writer.BaseStream.Seek(startPos + 2, SeekOrigin.Begin);
        WriteBigEndian((uint)chunkSize);
        _writer.BaseStream.Seek(endPos, SeekOrigin.Begin);
    }

    private void WriteSync(int frameNumber, uint timestamp)
    {
        _writer.Write(QovTypes.ChunkTypeSync);
        _writer.Write((byte)0);
        WriteBigEndian(8u);
        WriteBigEndian(timestamp);
        _writer.Write((byte)'Q');
        _writer.Write((byte)'O');
        _writer.Write((byte)'V');
        _writer.Write((byte)'S');
        WriteBigEndian((uint)frameNumber);
    }

    private void WriteEndMarker(BinaryWriter writer)
    {
        for (int i = 0; i < 7; i++) writer.Write((byte)0);
        writer.Write((byte)1);
    }

    private void WriteBigEndian(ushort value)
    {
        _writer.Write((byte)((value >> 8) & 0xFF));
        _writer.Write((byte)(value & 0xFF));
    }

    private void WriteBigEndian(uint value)
    {
        _writer.Write((byte)((value >> 24) & 0xFF));
        _writer.Write((byte)((value >> 16) & 0xFF));
        _writer.Write((byte)((value >> 8) & 0xFF));
        _writer.Write((byte)(value & 0xFF));
    }

    private void WriteBigEndian24(uint value)
    {
        _writer.Write((byte)((value >> 16) & 0xFF));
        _writer.Write((byte)((value >> 8) & 0xFF));
        _writer.Write((byte)(value & 0xFF));
    }

    public void Finish()
    {
        // Write index and end marker first (at current position = end of file)
        WriteIndex();
        WriteEnd();
        // Update frame count in header last (safe to seek now, all data written)
        UpdateFrameCount();
        _writer.Flush();
    }

    private void WriteIndex()
    {
        if (_keyframes.Count == 0) return;

        long startPos = _writer.BaseStream.Position;

        // Write chunk header (10 bytes for version 0x02)
        _writer.Write(QovTypes.ChunkTypeIndex);      // 1 byte: chunk_type
        _writer.Write((byte)0);                      // 1 byte: chunk_flags
        WriteBigEndian(0u);                          // 4 bytes: chunk_size placeholder (big-endian)
        WriteBigEndian(0u);                          // 4 bytes: timestamp (big-endian)

        long dataStartPos = _writer.BaseStream.Position;

        // Write entry count
        WriteBigEndian((uint)_keyframes.Count);

        // Write index entries (16 bytes each)
        foreach (var entry in _keyframes)
        {
            WriteBigEndian(entry.FrameNumber);                       // 4 bytes
            WriteBigEndian((uint)(entry.FileOffset >> 32));          // 4 bytes (high)
            WriteBigEndian((uint)(entry.FileOffset & 0xFFFFFFFF));   // 4 bytes (low)
            WriteBigEndian(entry.Timestamp);                         // 4 bytes
        }

        // Update chunk size in header
        long endPos = _writer.BaseStream.Position;
        long chunkSize = endPos - dataStartPos;

        _writer.BaseStream.Seek(startPos + 2, SeekOrigin.Begin);
        WriteBigEndian((uint)chunkSize);
        _writer.BaseStream.Seek(endPos, SeekOrigin.Begin);
    }

    private void WriteEnd()
    {
        // Write chunk header (10 bytes for version 0x02)
        _writer.Write(QovTypes.ChunkTypeEnd);        // 1 byte: chunk_type = 0xFF
        _writer.Write((byte)0);                      // 1 byte: chunk_flags = 0x00
        WriteBigEndian(0u);                          // 4 bytes: chunk_size = 0 (big-endian)
        WriteBigEndian(0u);                          // 4 bytes: timestamp = 0 (big-endian)

        // Write 8-byte end pattern: 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01
        for (int i = 0; i < 7; i++)
            _writer.Write((byte)0);
        _writer.Write((byte)1);
    }

    private void UpdateFrameCount()
    {
        _writer.BaseStream.Seek(14, SeekOrigin.Begin);
        WriteBigEndian((uint)_frameCount);
    }

    public int FrameCount => _frameCount;
}