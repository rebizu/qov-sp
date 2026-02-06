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
    private QoaDecoder? _qoaDecoder;

    private byte[] _prevYPlane, _currYPlane;
    private byte[] _prevUPlane, _currUPlane;
    private byte[] _prevVPlane, _currVPlane;

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
        _prevYPlane = _currYPlane = Array.Empty<byte>();
        _prevUPlane = _currUPlane = Array.Empty<byte>();
        _prevVPlane = _currVPlane = Array.Empty<byte>();
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
        _prevYPlane = _currYPlane = Array.Empty<byte>();
        _prevUPlane = _currUPlane = Array.Empty<byte>();
        _prevVPlane = _currVPlane = Array.Empty<byte>();
    }

    public QovHeader DecodeHeader()
    {
        byte[] magic = ReadBytes(4);
        string magicStr = System.Text.Encoding.ASCII.GetString(magic);

        if (magicStr != QovTypes.Magic)
            throw new QovException($"Invalid QOV magic: {magicStr}");

        byte version = ReadByte();
        if (version != QovTypes.Version1 && version != QovTypes.Version2 && version != QovTypes.Version3)
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
        byte quality = ReadByte();

        byte yQuant = 0, uvQuant = 0, tempThresh = 0, dctQp = 0;

        if (version == QovTypes.Version3)
        {
            yQuant = ReadByte();
            uvQuant = ReadByte();
            tempThresh = ReadByte();
            dctQp = ReadByte();
            ReadBigEndianU32(); // Reserved
        }

        _header = new QovHeader(flags, width, height, frameRateNum, frameRateDen, colorspace, audioChannels, audioRate, totalFrames,
            quality, yQuant, uvQuant, tempThresh, dctQp);        
        _prevFrame = new byte[width * height * 4];
        _currFrame = new byte[width * height * 4];

        // Allocate YUV buffers if needed
        bool isYuv = colorspace >= QovTypes.ColorspaceYuv420 && colorspace <= QovTypes.ColorspaceYuva420;
        if (isYuv)
        {
            int ySize = width * height;
            int uvW = (colorspace == QovTypes.ColorspaceYuv444) ? width : (width + 1) / 2;
            int uvH = (colorspace == QovTypes.ColorspaceYuv444) ? height : 
                      (colorspace == QovTypes.ColorspaceYuv422) ? height : (height + 1) / 2;
            int uvSize = uvW * uvH;

            _prevYPlane = new byte[ySize]; _currYPlane = new byte[ySize];
            _prevUPlane = new byte[uvSize]; _currUPlane = new byte[uvSize];
            _prevVPlane = new byte[uvSize]; _currVPlane = new byte[uvSize];
        }
        
        if (audioChannels > 0)
        {
            _qoaDecoder = new QoaDecoder();
        }

        return _header;
    }

    public IEnumerable<QovFrame> DecodeFrames()
    {
        foreach (var item in DecodeAll())
        {
            if (item is QovFrame frame)
            {
                yield return frame;
            }
        }
    }

    public IEnumerable<object> DecodeAll()
    {
        while (true)
        {
            bool shouldContinue = true;
            object? decodedItem = null;

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
                        decodedItem = DecodeKeyframe(chunkFlags, timestamp, chunkSize);
                        break;

                    case QovTypes.ChunkTypePframe:
                        decodedItem = DecodePFrame(chunkFlags, timestamp, chunkSize);
                        break;

                    case QovTypes.ChunkTypeBframe:
                        ReadBytes((int)chunkSize);
                        break;

                    case QovTypes.ChunkTypeAudio:
                        byte[] audioBytes = ReadBytes((int)chunkSize);
                        if (_qoaDecoder != null)
                        {
                            var result = _qoaDecoder.DecodeFrame(audioBytes);
                            if (result.HasValue)
                            {
                                var tuple = result.Value;
                                decodedItem = new QovAudioFrame
                                {
                                    Samples = tuple.Samples,
                                    Channels = tuple.Channels,
                                    SampleRate = tuple.SampleRate,
                                    Timestamp = timestamp
                                };
                            }
                        }
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

            if (decodedItem != null)
                yield return decodedItem;
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
            int yEnd = DecodeYuvPlane(frameData, 0, _currYPlane);
            int uEnd = DecodeYuvPlane(frameData, yEnd, _currUPlane);
            DecodeYuvPlane(frameData, uEnd, _currVPlane);

            ColorConversion.Yuv420ToRgba(_currYPlane, _currUPlane, _currVPlane, _header.Width, _header.Height, _currFrame);
            SwapYuvPlanes();
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
            // Decode temporal YUV planes using persistent previous buffer as reference
            int pos = 0;
            
            if ((chunkFlags & QovTypes.ChunkFlagDctBlocks) != 0)
            {
                // Init input planes from previous reference for DCT
                Array.Copy(_prevYPlane, _currYPlane, _prevYPlane.Length);
                Array.Copy(_prevUPlane, _currUPlane, _prevUPlane.Length);
                Array.Copy(_prevVPlane, _currVPlane, _prevVPlane.Length);

                float[] blockBuf = new float[64];
                int uvW = (_header.Width + 1) / 2;
                int uvH = (_header.Height + 1) / 2;

                pos = DecodePlaneDct(frameData, pos, _currYPlane, _header.Width, _header.Height, Dct.DefaultQuantLuma, QovTypes.OpDctY, blockBuf);
                pos = DecodePlaneDct(frameData, pos, _currUPlane, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf);
                pos = DecodePlaneDct(frameData, pos, _currVPlane, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf);
            }
            else
            {
                pos = DecodeYuvPlaneTemporal(frameData, pos, _currYPlane, _prevYPlane);
                pos = DecodeYuvPlaneTemporal(frameData, pos, _currUPlane, _prevUPlane);
                pos = DecodeYuvPlaneTemporal(frameData, pos, _currVPlane, _prevVPlane);
            }

            // Convert decoded YUV back to RGBA
            ColorConversion.Yuv420ToRgba(_currYPlane, _currUPlane, _currVPlane, _header.Width, _header.Height, _currFrame);
            SwapYuvPlanes();
        }
        else
        {
            DecodeRgbPFrame(frameData, (chunkFlags & QovTypes.ChunkFlagMotion) != 0);
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

    private void DecodeRgbPFrame(byte[] data, bool hasMotion)
    {
        int pixelCount = _header.Width * _header.Height;
        int px = 0;
        int pos = 0;

        // Correct Logic matching TS:
        // If !hasMotion, we copy Reference -> Target (making Target a clone of Reference).
        // If hasMotion, we assume Target (which was 2 frames ago) serves as the base for new diffs.
        if (!hasMotion)
        {
            Array.Copy(_prevFrame, _currFrame, _prevFrame.Length);
        }

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

                _currFrame[offset] = (byte)((_currFrame[offset] + dr) & 0xFF);
                _currFrame[offset + 1] = (byte)((_currFrame[offset + 1] + dg) & 0xFF);
                _currFrame[offset + 2] = (byte)((_currFrame[offset + 2] + db) & 0xFF);
                _currFrame[offset + 3] = _currFrame[offset + 3];

                int hash = (_currFrame[offset] * 3 + _currFrame[offset + 1] * 5 +
                    _currFrame[offset + 2] * 7 + _currFrame[offset + 3] * 11) % 64;
                _colorIndex[hash] = new QovPixel(_currFrame[offset], _currFrame[offset + 1],
                    _currFrame[offset + 2], _currFrame[offset + 3]);

                px++;
            }
            else if ((b1 & 0xC0) == 0x80)
            {
                byte b2 = data[pos++];
                int offset = px * 4;
                int dg = (b1 & 0x3F) - 32;
                int drDg = ((b2 >> 4) & 0x0F) - 8;
                int dbDg = (b2 & 0x0F) - 8;

                _currFrame[offset] = (byte)((_currFrame[offset] + dg + drDg) & 0xFF);
                _currFrame[offset + 1] = (byte)((_currFrame[offset + 1] + dg) & 0xFF);
                _currFrame[offset + 2] = (byte)((_currFrame[offset + 2] + dg + dbDg) & 0xFF);

                int hash = (_currFrame[offset] * 3 + _currFrame[offset + 1] * 5 +
                    _currFrame[offset + 2] * 7 + _currFrame[offset + 3] * 11) % 64;
                _colorIndex[hash] = new QovPixel(_currFrame[offset], _currFrame[offset + 1],
                    _currFrame[offset + 2], _currFrame[offset + 3]);

                px++;
            }
            else if ((b1 & 0xC0) == 0x00)
            {
                int idx = b1 & 0x3F;
                int offset = px * 4;
                _currFrame[offset] = _colorIndex[idx].R;
                _currFrame[offset + 1] = _colorIndex[idx].G;
                _currFrame[offset + 2] = _colorIndex[idx].B;
                _currFrame[offset + 3] = _colorIndex[idx].A;
                px++;
            }
            else if (b1 == 0xFE)
            {
                int offset = px * 4;
                _currFrame[offset] = data[pos++];
                _currFrame[offset + 1] = data[pos++];
                _currFrame[offset + 2] = data[pos++];
                
                int hash = (_currFrame[offset] * 3 + _currFrame[offset + 1] * 5 +
                    _currFrame[offset + 2] * 7 + _currFrame[offset + 3] * 11) % 64;
                _colorIndex[hash] = new QovPixel(_currFrame[offset], _currFrame[offset + 1],
                    _currFrame[offset + 2], _currFrame[offset + 3]);
                    
                px++;
            }
            else if (b1 == 0xFF)
            {
                int offset = px * 4;
                _currFrame[offset] = data[pos++];
                _currFrame[offset + 1] = data[pos++];
                _currFrame[offset + 2] = data[pos++];
                _currFrame[offset + 3] = data[pos++];
                
                int hash = (_currFrame[offset] * 3 + _currFrame[offset + 1] * 5 +
                    _currFrame[offset + 2] * 7 + _currFrame[offset + 3] * 11) % 64;
                _colorIndex[hash] = new QovPixel(_currFrame[offset], _currFrame[offset + 1],
                    _currFrame[offset + 2], _currFrame[offset + 3]);
                    
                px++;
            }
        }
        // SwapFrames() called by caller will make _currFrame the new _prevFrame (valid).
    }

    private int DecodeYuvPlane(byte[] data, int startPos, Span<byte> output)
    {
        int size = output.Length;
        byte prevVal = 0;
        int[] index = new int[64];
        // Initialize to -1 to prevent false matches with value 0 (critical for YUV)
        Array.Fill(index, -1);
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
        // Initialize to -1 to prevent false matches with value 0 (critical for YUV)
        Array.Fill(index, -1);
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

    private void SwapYuvPlanes()
    {
        byte[] tempY = _prevYPlane; _prevYPlane = _currYPlane; _currYPlane = tempY;
        byte[] tempU = _prevUPlane; _prevUPlane = _currUPlane; _currUPlane = tempU;
        byte[] tempV = _prevVPlane; _prevVPlane = _currVPlane; _currVPlane = tempV;
    }

    private void SwapFrames()
    {
        byte[] temp = _prevFrame;
        _prevFrame = _currFrame;
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

    private int DecodeDctBlock(ReadOnlySpan<byte> data, ref int pos, int[] quantTable, byte qpBase, float[] output)
    {
        byte qpByte = data[pos++];
        int qpDelta = (qpByte & 0x7F) - 64;
        int finalQp = Math.Clamp(qpBase + qpDelta, 0, 100);
        float scale = 0.1f + (finalQp * 0.1f);

        ushort dcRaw = (ushort)((data[pos] << 8) | data[pos + 1]);
        pos += 2;
        int dc = (dcRaw & 0x8000) != 0 ? dcRaw - 65536 : dcRaw;

        float[] coeffs = new float[64];
        coeffs[0] = dc * quantTable[0] * scale;

        int k = 1;
        while (k < 64)
        {
            byte b1 = data[pos++];
            if (b1 == 0x00) break; // EOB
            if (b1 == 0xF0) { k += 16; continue; } // ZRL

            int run = (b1 >> 4) & 0x0F;
            int size = b1 & 0x0F;

            k += run;
            if (k >= 64) break;

            int level = 0;
            if (size > 0)
            {
                uint rawLevel = 0;
                for (int i = 0; i < size; i++) rawLevel = (rawLevel << 8) | data[pos++];

                if (size == 1) level = (rawLevel & 0x80) != 0 ? (int)rawLevel - 256 : (int)rawLevel;
                else if (size == 2) level = (rawLevel & 0x8000) != 0 ? (int)rawLevel - 65536 : (int)rawLevel;
                else level = (int)rawLevel;
            }

            coeffs[Dct.ZigZag[k]] = level * quantTable[Dct.ZigZag[k]] * scale;
            k++;
        }

        Dct.InverseDctRaw(coeffs, output);
        return k; // Return value not strictly needed but matches structure
    }

    private int DecodePlaneDct(ReadOnlySpan<byte> data, int startPos, byte[] plane, int w, int h, int[] quantTable, byte opType, float[] blockBuf)
    {
        byte qpBase = _header.DctQpBase != 0 ? _header.DctQpBase : (byte)20;
        int blocksX = (int)Math.Ceiling(w / 8.0);
        int blocksY = (int)Math.Ceiling(h / 8.0);
        int totalBlocks = blocksX * blocksY;
        int blockIdx = 0;
        int pos = startPos;

        while (blockIdx < totalBlocks)
        {
            byte b1 = data[pos++];
            if (b1 == QovTypes.OpDctSkip)
            {
                byte count = data[pos++];
                blockIdx += count;
            }
            else if (b1 == QovTypes.OpDctZero)
            {
                byte count = data[pos++];
                blockIdx += count;
            }
            else if (b1 == opType)
            {
                DecodeDctBlock(data, ref pos, quantTable, qpBase, blockBuf);
                
                int bx = (blockIdx % blocksX) * 8;
                int by = (blockIdx / blocksX) * 8;

                for (int y = 0; y < 8; y++)
                {
                    if (by + y >= h) break;
                    for (int x = 0; x < 8; x++)
                    {
                        if (bx + x >= w) break;
                        int idx = (by + y) * w + (bx + x);
                        int val = plane[idx] + (int)blockBuf[y * 8 + x];
                        plane[idx] = (byte)Math.Clamp(val, 0, 255);
                    }
                }
                blockIdx++;
            }
            else
            {
                 // Handle unexpected opcode or sync error
                 Console.WriteLine($"[Decoder] Unexpected opcode 0x{b1:X2} in DCT stream at block {blockIdx}");
                 blockIdx++;
            }
        }
        return pos;
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

public readonly struct QovAudioFrame
{
    public float[] Samples { get; init; }
    public int Channels { get; init; }
    public int SampleRate { get; init; }
    public uint Timestamp { get; init; }
}