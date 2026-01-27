namespace QovLibrary;

/// <summary>
/// QOV Decoder - decodes QOV files with sync markers, chunks, and opcode decoding.
/// </summary>
public class QovDecoder
{
    private BinaryReader? _reader;
    private byte[] _data;
    private int _position;
    private QovHeader _header;
    private QovPixel[] _colorIndex;
    private QovPixel _prevPixel;
    private byte[] _prevFrame;
    private byte[] _currFrame;
    private bool _use32BitChunkSize;
    private int _frameCount;

    public QovDecoder(Stream input) : base()
    {
        _reader = new BinaryReader(input, System.Text.Encoding.ASCII, leaveOpen: true);
        _data = Array.Empty<byte>();
        _prevFrame = Array.Empty<byte>();
        _currFrame = Array.Empty<byte>();
        _colorIndex = new QovPixel[64];
        _prevPixel = new QovPixel(0, 0, 0, 255);
        _use32BitChunkSize = false;
        _frameCount = 0;
    }

    public QovDecoder(byte[] data) : base()
    {
        _data = data;
        _reader = null!;
        _prevFrame = new byte[data.Length];
        _currFrame = new byte[data.Length];
        _colorIndex = new QovPixel[64];
        _prevPixel = new QovPixel(0, 0, 0, 255);
        _use32BitChunkSize = false;
        _frameCount = 0;
    }

    public QovHeader DecodeHeader()
    {
        byte[] magic = ReadBytes(4);
        string magicStr = System.Text.Encoding.ASCII.GetString(magic);

        if (magicStr != QovTypes.Magic)
            throw new QovException($"Invalid QOV magic: {magicStr}");

        byte version = ReadByte();
        if (version != QovTypes.Version1 && version != QovTypes.Version2)
            throw new QovException($"Unsupported QOV version: 0x{version:X2}");

        _use32BitChunkSize = version >= QovTypes.Version2;

        byte flags = ReadByte();
        ushort width = ReadBigEndianU16();
        ushort height = ReadBigEndianU16();
        ushort frameRateNum = ReadBigEndianU16();
        ushort frameRateDen = ReadBigEndianU16();
        uint totalFrames = ReadBigEndianU32();
        byte audioChannels = ReadByte();
        uint audioRate = ReadBigEndianU24();
        byte colorspace = ReadByte();
        ReadByte();

        _header = new QovHeader(flags, width, height, frameRateNum, frameRateDen, colorspace, audioChannels, audioRate, totalFrames);        
        _prevFrame = new byte[width * height * 4];
        _currFrame = new byte[width * height * 4];

        return _header;
    }

    public IEnumerable<QovFrame> DecodeFrames()
    {
        while (true)
        {
            bool shouldContinue = true;
            QovFrame? frame = null;

            try
            {
                byte chunkType = ReadByte();
                if (chunkType == QovTypes.ChunkTypeEnd)
                    break;

                byte chunkFlags = ReadByte();
                uint chunkSize = _use32BitChunkSize ? ReadBigEndianU32() : ReadBigEndianU16();
                uint timestamp = ReadBigEndianU32();

                switch (chunkType)
                {
                    case QovTypes.ChunkTypeSync:
                        ReadBytes((int)chunkSize);
                        break;

                    case QovTypes.ChunkTypeKeyframe:
                        frame = DecodeKeyframe(chunkFlags, timestamp, chunkSize);
                        break;

                    case QovTypes.ChunkTypePframe:
                        frame = DecodePFrame(chunkFlags, timestamp, chunkSize);
                        break;

                    case QovTypes.ChunkTypeBframe:
                        ReadBytes((int)chunkSize);
                        break;

                    case QovTypes.ChunkTypeAudio:
                        ReadBytes((int)chunkSize);
                        break;

                    case QovTypes.ChunkTypeIndex:
                        ReadBytes((int)chunkSize);
                        break;

                    default:
                        ReadBytes((int)chunkSize);
                        break;
                }
            }
            catch (EndOfStreamException)
            {
                shouldContinue = false;
            }

            if (!shouldContinue)
                break;

            if (frame.HasValue)
                yield return frame.Value;
        }
    }

    private QovFrame DecodeKeyframe(byte chunkFlags, uint timestamp, uint chunkSize)
    {
        bool isYuvChunk = (chunkFlags & QovTypes.ChunkFlagYuv) != 0;
        bool isCompressed = (chunkFlags & QovTypes.ChunkFlagCompressed) != 0;

        byte[] chunkData = ReadBytes((int)chunkSize);
        byte[] frameData = chunkData;

        if (isCompressed)
        {
            int pos = 0;
            uint uncompressedSize = ReadBigEndianU32(chunkData, ref pos);
            frameData = Lz4Compression.Decompress(chunkData.AsSpan(pos), (int)uncompressedSize);
        }

        if (isYuvChunk)
        {
            int pixelCount = _header.Width * _header.Height;
            int uvSize = ((pixelCount + 3) / 4);

            byte[] yPlane = new byte[pixelCount];
            byte[] uPlane = new byte[uvSize];
            byte[] vPlane = new byte[uvSize];

            int yEnd = DecodeYuvPlane(frameData, 0, yPlane);
            int uEnd = DecodeYuvPlane(frameData, yEnd, uPlane);
            DecodeYuvPlane(frameData, uEnd, vPlane);

            ColorConversion.Yuv420ToRgba(yPlane, uPlane, vPlane, _header.Width, _header.Height, _currFrame);
        }
        else
        {
            DecodeRgbKeyframe(frameData);
        }

        SwapFrames();

        return new QovFrame
        {
            Pixels = _prevFrame.ToArray(),
            Width = _header.Width,
            Height = _header.Height,
            Timestamp = timestamp,
            IsKeyframe = true,
            FrameNumber = (uint)_frameCount++
        };
    }

    private QovFrame DecodePFrame(byte chunkFlags, uint timestamp, uint chunkSize)
    {
        bool isYuvChunk = (chunkFlags & QovTypes.ChunkFlagYuv) != 0;
        bool isCompressed = (chunkFlags & QovTypes.ChunkFlagCompressed) != 0;

        byte[] chunkData = ReadBytes((int)chunkSize);
        byte[] frameData = chunkData;

        if (isCompressed)
        {
            int pos = 0;
            uint uncompressedSize = ReadBigEndianU32(chunkData, ref pos);
            frameData = Lz4Compression.Decompress(chunkData.AsSpan(pos), (int)uncompressedSize);
        }

        if (isYuvChunk)
        {
            int pixelCount = _header.Width * _header.Height;
            int uvSize = ((pixelCount + 3) / 4);

            // Convert previous RGBA frame to YUV420 to get reference planes
            ColorConversion.RgbaToYuv420(_currFrame, _header.Width, _header.Height,
                out byte[] prevY, out byte[] prevU, out byte[] prevV);

            // Allocate output planes (start as copy of previous)
            byte[] yPlane = new byte[pixelCount];
            byte[] uPlane = new byte[uvSize];
            byte[] vPlane = new byte[uvSize];

            // Decode temporal YUV planes directly from frameData (which contains encoded opcodes)
            int pos = 0;
            pos = DecodeYuvPlaneTemporal(frameData, pos, yPlane, prevY);
            pos = DecodeYuvPlaneTemporal(frameData, pos, uPlane, prevU);
            pos = DecodeYuvPlaneTemporal(frameData, pos, vPlane, prevV);

            // Convert decoded YUV back to RGBA
            ColorConversion.Yuv420ToRgba(yPlane, uPlane, vPlane, _header.Width, _header.Height, _currFrame);
        }
        else
        {
            DecodeRgbPFrame(frameData);
        }

        SwapFrames();

        return new QovFrame
        {
            Pixels = _prevFrame.ToArray(),
            Width = _header.Width,
            Height = _header.Height,
            Timestamp = timestamp,
            IsKeyframe = false,
            FrameNumber = (uint)_frameCount++
        };
    }

    private void DecodeRgbKeyframe(byte[] data)
    {
        int pixelCount = _header.Width * _header.Height;
        int px = 0;
        int pos = 0;

        Array.Clear(_colorIndex, 0, 64);
        _prevPixel = new QovPixel(0, 0, 0, 255);

        while (px < pixelCount && pos < data.Length - 8)
        {
            byte b1 = data[pos++];

            if (b1 == 0xFE)
            {
                _prevPixel = new QovPixel(data[pos++], data[pos++], data[pos++], _prevPixel.A);
            }
            else if (b1 == 0xFF)
            {
                _prevPixel = new QovPixel(data[pos++], data[pos++], data[pos++], data[pos++]);
            }
            else if ((b1 & 0xC0) == 0x00)
            {
                int idx = b1 & 0x3F;
                _prevPixel = _colorIndex[idx];
            }
            else if ((b1 & 0xC0) == 0x40)
            {
                int dr = ((b1 >> 4) & 0x03) - 2;
                int dg = ((b1 >> 2) & 0x03) - 2;
                int db = (b1 & 0x03) - 2;

                _prevPixel = new QovPixel(
                    (byte)((_prevPixel.R + dr) & 0xFF),
                    (byte)((_prevPixel.G + dg) & 0xFF),
                    (byte)((_prevPixel.B + db) & 0xFF),
                    _prevPixel.A
                );
            }
            else if ((b1 & 0xC0) == 0x80)
            {
                byte b2 = data[pos++];
                int dg = (b1 & 0x3F) - 32;
                int drDg = ((b2 >> 4) & 0x0F) - 8;
                int dbDg = (b2 & 0x0F) - 8;

                _prevPixel = new QovPixel(
                    (byte)((_prevPixel.R + dg + drDg) & 0xFF),
                    (byte)((_prevPixel.G + dg) & 0xFF),
                    (byte)((_prevPixel.B + dg + dbDg) & 0xFF),
                    _prevPixel.A
                );
            }
            else if ((b1 & 0xC0) == 0xC0)
            {
                int run = (b1 & 0x3F) + 1;
                for (int i = 0; i < run && px < pixelCount; i++)
                {
                    int offset = px * 4;
                    _currFrame[offset] = _prevPixel.R;
                    _currFrame[offset + 1] = _prevPixel.G;
                    _currFrame[offset + 2] = _prevPixel.B;
                    _currFrame[offset + 3] = _prevPixel.A;
                    px++;
                }
                continue;
            }

            int hash = (_prevPixel.R * 3 + _prevPixel.G * 5 + _prevPixel.B * 7 + _prevPixel.A * 11) % 64;
            _colorIndex[hash] = _prevPixel;

            int offset2 = px * 4;
            _currFrame[offset2] = _prevPixel.R;
            _currFrame[offset2 + 1] = _prevPixel.G;
            _currFrame[offset2 + 2] = _prevPixel.B;
            _currFrame[offset2 + 3] = _prevPixel.A;
            px++;
        }
    }

    private void DecodeRgbPFrame(byte[] data)
    {
        int pixelCount = _header.Width * _header.Height;
        int px = 0;
        int pos = 0;

        Array.Copy(_currFrame, _prevFrame, _currFrame.Length);

        while (px < pixelCount && pos < data.Length - 8)
        {
            byte b1 = data[pos++];

            if (b1 == 0x00)
            {
                ushort skip = ReadBigEndianU16(data, ref pos);
                px += skip;
                continue;
            }
            else if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE)
            {
                int skip = (b1 & 0x3F) + 1;
                px += skip;
                continue;
            }
            else if ((b1 & 0xC0) == 0x40)
            {
                int offset = px * 4;
                int dr = ((b1 >> 4) & 0x03) - 2;
                int dg = ((b1 >> 2) & 0x03) - 2;
                int db = (b1 & 0x03) - 2;

                _prevFrame[offset] = (byte)((_prevFrame[offset] + dr) & 0xFF);
                _prevFrame[offset + 1] = (byte)((_prevFrame[offset + 1] + dg) & 0xFF);
                _prevFrame[offset + 2] = (byte)((_prevFrame[offset + 2] + db) & 0xFF);
                _prevFrame[offset + 3] = _prevFrame[offset + 3];

                int hash = (_prevFrame[offset] * 3 + _prevFrame[offset + 1] * 5 +
                    _prevFrame[offset + 2] * 7 + _prevFrame[offset + 3] * 11) % 64;
                _colorIndex[hash] = new QovPixel(_prevFrame[offset], _prevFrame[offset + 1],
                    _prevFrame[offset + 2], _prevFrame[offset + 3]);

                px++;
            }
            else if ((b1 & 0xC0) == 0x80)
            {
                byte b2 = data[pos++];
                int offset = px * 4;
                int dg = (b1 & 0x3F) - 32;
                int drDg = ((b2 >> 4) & 0x0F) - 8;
                int dbDg = (b2 & 0x0F) - 8;

                _prevFrame[offset] = (byte)((_prevFrame[offset] + dg + drDg) & 0xFF);
                _prevFrame[offset + 1] = (byte)((_prevFrame[offset + 1] + dg) & 0xFF);
                _prevFrame[offset + 2] = (byte)((_prevFrame[offset + 2] + dg + dbDg) & 0xFF);

                int hash = (_prevFrame[offset] * 3 + _prevFrame[offset + 1] * 5 +
                    _prevFrame[offset + 2] * 7 + _prevFrame[offset + 3] * 11) % 64;
                _colorIndex[hash] = new QovPixel(_prevFrame[offset], _prevFrame[offset + 1],
                    _prevFrame[offset + 2], _prevFrame[offset + 3]);

                px++;
            }
            else if ((b1 & 0xC0) == 0x00)
            {
                int idx = b1 & 0x3F;
                int offset = px * 4;
                _prevFrame[offset] = _colorIndex[idx].R;
                _prevFrame[offset + 1] = _colorIndex[idx].G;
                _prevFrame[offset + 2] = _colorIndex[idx].B;
                _prevFrame[offset + 3] = _colorIndex[idx].A;
                px++;
            }
            else if (b1 == 0xFE)
            {
                int offset = px * 4;
                _prevFrame[offset] = data[pos++];
                _prevFrame[offset + 1] = data[pos++];
                _prevFrame[offset + 2] = data[pos++];
                px++;
            }
            else if (b1 == 0xFF)
            {
                int offset = px * 4;
                _prevFrame[offset] = data[pos++];
                _prevFrame[offset + 1] = data[pos++];
                _prevFrame[offset + 2] = data[pos++];
                _prevFrame[offset + 3] = data[pos++];
                px++;
            }
        }

        _prevFrame.CopyTo(_currFrame, 0);
    }

    private int DecodeYuvPlane(byte[] data, int startPos, Span<byte> output)
    {
        int size = output.Length;
        byte prevVal = 0;
        int[] index = new int[64];
        int px = 0;
        int pos = startPos;

        while (px < size && pos < data.Length)
        {
            byte b1 = data[pos++];

            if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE)
            {
                int run = (b1 & 0x3F) + 1;
                for (int i = 0; i < run && px < size; i++)
                {
                    output[px++] = prevVal;
                }
            }
            else if ((b1 & 0xC0) == 0x00)
            {
                int idx = b1 & 0x3F;
                prevVal = (byte)index[idx];
                output[px++] = prevVal;
            }
            else if ((b1 & 0xC0) == 0x40)
            {
                int d = (b1 & 0x0F) - 8;
                prevVal = (byte)((prevVal + d) & 0xFF);
                int idx = (prevVal * 3) % 64;
                index[idx] = prevVal;
                output[px++] = prevVal;
            }
            else if ((b1 & 0xC0) == 0x80)
            {
                int d = (b1 & 0x3F) - 32;
                prevVal = (byte)((prevVal + d) & 0xFF);
                int idx = (prevVal * 3) % 64;
                index[idx] = prevVal;
                output[px++] = prevVal;
            }
            else if (b1 == 0xFE)
            {
                prevVal = data[pos++];
                int idx = (prevVal * 3) % 64;
                index[idx] = prevVal;
                output[px++] = prevVal;
            }
        }

        return pos;
    }

    private int DecodeYuvPlaneTemporal(byte[] data, int startPos, Span<byte> output, Span<byte> prevPlane)
    {
        int size = output.Length;
        int[] index = new int[64];
        int px = 0;
        int pos = startPos;

        prevPlane.CopyTo(output);

        while (px < size && pos < data.Length)
        {
            byte b1 = data[pos++];

            if (b1 == 0x00)
            {
                ushort skipCount = ReadBigEndianU16(data, ref pos);
                px += skipCount;
            }
            else if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE)
            {
                int skipCount = (b1 & 0x3F) + 1;
                px += skipCount;
            }
            else if ((b1 & 0xC0) == 0x40)
            {
                int d = (b1 & 0x0F) - 8;
                output[px] = (byte)((prevPlane[px] + d) & 0xFF);
                int idx = (output[px] * 3) % 64;
                index[idx] = output[px];
                px++;
            }
            else if ((b1 & 0xC0) == 0x80)
            {
                int d = (b1 & 0x3F) - 32;
                output[px] = (byte)((prevPlane[px] + d) & 0xFF);
                int idx = (output[px] * 3) % 64;
                index[idx] = output[px];
                px++;
            }
            else if ((b1 & 0xC0) == 0x00)
            {
                int idx = b1 & 0x3F;
                output[px] = (byte)index[idx];
                px++;
            }
            else if (b1 == 0xFE)
            {
                output[px] = data[pos++];
                int idx = (output[px] * 3) % 64;
                index[idx] = output[px];
                px++;
            }
        }

        return pos;
    }

    private void SwapFrames()
    {
        byte[] temp = _prevFrame;
        Array.Copy(_currFrame, _prevFrame, _currFrame.Length);
        _currFrame = temp;
    }

    private byte ReadByte()
    {
        if (_reader != null)
            return _reader.ReadByte();
        else
            return _data[_position++];
    }

    private byte[] ReadBytes(int count)
    {
        if (_reader != null)
            return _reader.ReadBytes(count);
        byte[] result = new byte[count];
        Array.Copy(_data, _position, result, 0, count);
        _position += count;
        return result;
    }

    private ushort ReadBigEndianU16()
    {
        byte[] bytes = ReadBytes(2);
        return (ushort)((bytes[0] << 8) | bytes[1]);
    }

    private uint ReadBigEndianU32()
    {
        byte[] bytes = ReadBytes(4);
        return (uint)((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
    }

    private uint ReadBigEndianU24()
    {
        byte[] bytes = ReadBytes(3);
        return (uint)((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]);
    }

    private uint ReadBigEndianU32(byte[] data, ref int pos)
    {
        uint value = (uint)((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]);
        pos += 4;
        return value;
    }

    private ushort ReadBigEndianU16(byte[] data, ref int pos)
    {
        ushort value = (ushort)((data[pos] << 8) | data[pos + 1]);
        pos += 2;
        return value;
    }

    private byte[] ReadBytes(byte[] data, ref int pos, int count)
    {
        byte[] result = new byte[count];
        Array.Copy(data, pos, result, 0, count);
        pos += count;
        return result;
    }
}

public readonly struct QovFrame
{
    public byte[] Pixels { get; init; }
    public ushort Width { get; init; }
    public ushort Height { get; init; }
    public uint Timestamp { get; init; }
    public bool IsKeyframe { get; init; }
    public uint FrameNumber { get; init; }
}