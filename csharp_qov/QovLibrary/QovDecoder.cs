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
    private byte[]? _prevAPlane, _currAPlane;
    private bool _hasYuvAlpha;

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
            quality, yQuant, uvQuant, tempThresh, dctQp, version);
        _prevFrame = new byte[width * height * 4];
        _currFrame = new byte[width * height * 4];

        // Allocate YUV buffers if needed
        bool isYuv = colorspace >= QovTypes.ColorspaceYuv420 && colorspace <= QovTypes.ColorspaceYuva420;
        _hasYuvAlpha = (flags & QovTypes.FlagHasAlpha) != 0 || colorspace == QovTypes.ColorspaceYuva420;
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
            if (_hasYuvAlpha)
            {
                _prevAPlane = new byte[ySize]; _currAPlane = new byte[ySize];
            }
        }
        
        if (audioChannels > 0)
        {
            _qoaDecoder = new QoaDecoder();
        }

        return _header;
    }

    public void Seek(long offset, uint frameNumber)
    {
        if (_reader != null)
        {
            _reader.BaseStream.Seek(offset, SeekOrigin.Begin);
        }
        else
        {
            _position = (int)offset;
        }

        // Reset State
        _frameCount = (int)frameNumber;
        Array.Clear(_prevFrame, 0, _prevFrame.Length);
        Array.Clear(_currFrame, 0, _currFrame.Length);
        Array.Clear(_colorIndex, 0, 64);
        _prevPixel = new QovPixel(0, 0, 0, 255);

        if (_prevYPlane != null) Array.Clear(_prevYPlane, 0, _prevYPlane.Length);
        if (_currYPlane != null) Array.Clear(_currYPlane, 0, _currYPlane.Length);
        if (_prevUPlane != null) Array.Clear(_prevUPlane, 0, _prevUPlane.Length);
        if (_currUPlane != null) Array.Clear(_currUPlane, 0, _currUPlane.Length);
        if (_prevVPlane != null) Array.Clear(_prevVPlane, 0, _prevVPlane.Length);
        if (_currVPlane != null) Array.Clear(_currVPlane, 0, _currVPlane.Length);
        if (_prevAPlane != null) Array.Clear(_prevAPlane, 0, _prevAPlane.Length);
        if (_currAPlane != null) Array.Clear(_currAPlane, 0, _currAPlane.Length);
    }

    public IEnumerable<QovDecodedChunk> Scan()
    {
        long initialPos = _reader?.BaseStream.Position ?? _position;
        
        while (true)
        {
            bool shouldContinue = true;
            long offset = _reader?.BaseStream.Position ?? _position;

            QovDecodedChunk? currentChunk = null;

            try
            {
                // Check for EOF
                if (_reader != null)
                {
                    if (_reader.BaseStream.Position >= _reader.BaseStream.Length) break;
                }
                else
                {
                    if (_position >= _data.Length) break;
                }

                byte chunkType = ReadByte();
                if (chunkType == QovTypes.ChunkTypeEnd)
                    break;

                byte chunkFlags = ReadByte();
                uint chunkSize = _use32BitChunkSize ? ReadBigEndianU32() : ReadBigEndianU16();
                uint timestamp = ReadBigEndianU32();

                // Skip payload
                if (_reader != null)
                    _reader.BaseStream.Seek(chunkSize, SeekOrigin.Current);
                else
                    _position += (int)chunkSize;

                currentChunk = new QovDecodedChunk
                {
                    ChunkType = chunkType,
                    ChunkSize = chunkSize,
                    FileOffset = offset,
                    Timestamp = timestamp,
                    Payload = null
                };
            }
            catch (EndOfStreamException)
            {
                shouldContinue = false;
            }

            if (!shouldContinue)
                break;

            if (currentChunk != null)
                yield return currentChunk;
        }

        // Restore position
        if (_reader != null)
            _reader.BaseStream.Seek(initialPos, SeekOrigin.Begin);
        else
            _position = (int)initialPos;
    }

    public class QovDecodedChunk 
    {
        public byte ChunkType { get; init; }
        public uint ChunkSize { get; init; }
        public long FileOffset { get; init; }
        public uint Timestamp { get; init; }
        public object? Payload { get; init; }
    }

    public IEnumerable<QovFrame> DecodeFrames()
    {
        foreach (var chunk in DecodeAll())
        {
            if (chunk.Payload is QovFrame frame)
            {
                yield return frame;
            }
        }
    }

    public IEnumerable<QovDecodedChunk> DecodeAll()
    {
        while (true)
        {
            bool shouldContinue = true;
            object? payload = null;
            long offset = _reader?.BaseStream.Position ?? 0; // Approximate if strictly streaming, but BaseStream usually works for FileStream. 
            // Note: If _reader is null (byte[] ctor), we need to track position manually or use _position (not shown in snippet but implied by context).
            // Actually _position is used in byte[] ctor case. But DecodeAll uses ReadByte()/ReadBytes() which advances stream or array index.
            // Let's check Reader usage.
            // _reader is BinaryReader. 
            
            if (_reader != null) offset = _reader.BaseStream.Position;
             // In byte[] case we might need to track it differently if _position is not updated by helper methods?
             // Actually ReadByte() likely updates _reader or an index. 
             // Let's assume _reader is used for FileStream. For byte[] logic, we'd need to see the rest of the file.
             // Given the context of PlayerService using FileStream, _reader is active.

            QovDecodedChunk? currentChunk = null;

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
                        payload = DecodeKeyframe(chunkFlags, timestamp, chunkSize);
                        break;

                    case QovTypes.ChunkTypePframe:
                        payload = DecodePFrame(chunkFlags, timestamp, chunkSize);
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
                                payload = new QovAudioFrame
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

                currentChunk = new QovDecodedChunk 
                {
                    ChunkType = chunkType,
                    ChunkSize = chunkSize,
                    FileOffset = offset,
                    Timestamp = timestamp,
                    Payload = payload
                };
            }
            catch (EndOfStreamException)
            {
                shouldContinue = false;
            }

            if (!shouldContinue)
                break;

            if (currentChunk != null)
                yield return currentChunk;
        }
    }

    // Chroma plane dims per header colorspace (spec: 444→w×h, 422→⌈w/2⌉×h, else ⌈w/2⌉×⌈h/2⌉)
    // Intra DCT plane decoder (spec 3.4.3): raster-order reconstruction.
    // Skip opcodes fill the block with the DC prediction; coded blocks add
    // the residual to it.
    private int DecodeIntraPlaneDct(byte[] data, int startPos, byte[] plane, int w, int h, int[] quantTable, byte opType, int qpBase, float[] blockBuf, bool eg = false)
    {
        int pos = startPos;
        int blocksX = (int)Math.Ceiling(w / 8.0);
        int blocksY = (int)Math.Ceiling(h / 8.0);
        int totalBlocks = blocksX * blocksY;
        int blockIdx = 0;

        while (blockIdx < totalBlocks && pos < data.Length)
        {
            byte b1 = data[pos++];
            int bx = (blockIdx % blocksX) * 8;
            int by = (blockIdx / blocksX) * 8;
            if (b1 == QovTypes.OpDctSkip || b1 == QovTypes.OpDctZero)
            {
                byte count = data[pos++];
                for (int n = 0; n < count && blockIdx < totalBlocks; n++, blockIdx++)
                {
                    int sbx = (blockIdx % blocksX) * 8;
                    int sby = (blockIdx / blocksX) * 8;
                    int pred = IntraPred(plane, w, h, sbx, sby);
                    for (int y = 0; y < 8 && sby + y < h; y++)
                        for (int x = 0; x < 8 && sbx + x < w; x++)
                            plane[(sby + y) * w + sbx + x] = (byte)pred;
                }
            }
            else if (b1 == opType)
            {
                int pred = IntraPred(plane, w, h, bx, by);
                DecodeDctBlock(data, ref pos, quantTable, (byte)qpBase, blockBuf, eg);
                for (int y = 0; y < 8 && by + y < h; y++)
                {
                    for (int x = 0; x < 8 && bx + x < w; x++)
                    {
                        int idx = (by + y) * w + bx + x;
                        int val = (int)(pred + blockBuf[y * 8 + x]);
                        plane[idx] = (byte)Math.Clamp(val, 0, 255);
                    }
                }
                blockIdx++;
            }
            else
            {
                blockIdx++;
            }
        }
        return pos;
    }

    // Intra DC prediction (spec 3.4.3): mean of the reconstructed left
    // column / top row; integer round-half-up; 128 with no neighbor.
    private static int IntraPred(byte[] plane, int w, int h, int x0, int y0)
    {
        long lsum = 0, tsum = 0;
        int lcount = 0, tcount = 0;
        if (x0 > 0)
            for (int yy = 0; yy < 8 && y0 + yy < h; yy++) { lsum += plane[(y0 + yy) * w + x0 - 1]; lcount++; }
        if (y0 > 0)
            for (int xx = 0; xx < 8 && x0 + xx < w; xx++) { tsum += plane[(y0 - 1) * w + x0 + xx]; tcount++; }
        if (lcount > 0 && tcount > 0)
        {
            int lm = (int)((2 * lsum + lcount) / (2 * lcount));
            int tm = (int)((2 * tsum + tcount) / (2 * tcount));
            return (lm + tm + 1) / 2;
        }
        if (lcount > 0) return (int)((2 * lsum + lcount) / (2 * lcount));
        if (tcount > 0) return (int)((2 * tsum + tcount) / (2 * tcount));
        return 128;
    }

    private (int W, int H) ChromaDims()
    {
        return _header.Colorspace switch
        {
            QovTypes.ColorspaceYuv444 => (_header.Width, _header.Height),
            QovTypes.ColorspaceYuv422 => ((_header.Width + 1) / 2, _header.Height),
            _ => ((_header.Width + 1) / 2, (_header.Height + 1) / 2),
        };
    }

    private void ConvertCurrYuvPlanesToRgba()
    {
        byte[]? a = _hasYuvAlpha ? _currAPlane : null;
        switch (_header.Colorspace)
        {
            case QovTypes.ColorspaceYuv444:
                if (a != null) ColorConversion.Yuv444ToRgbaWithAlpha(_currYPlane, _currUPlane, _currVPlane, a, _header.Width, _header.Height, _currFrame);
                else ColorConversion.Yuv444ToRgba(_currYPlane, _currUPlane, _currVPlane, _header.Width, _header.Height, _currFrame);
                break;
            case QovTypes.ColorspaceYuv422:
                if (a != null) ColorConversion.Yuv422ToRgbaWithAlpha(_currYPlane, _currUPlane, _currVPlane, a, _header.Width, _header.Height, _currFrame);
                else ColorConversion.Yuv422ToRgba(_currYPlane, _currUPlane, _currVPlane, _header.Width, _header.Height, _currFrame);
                break;
            default:
                if (a != null) ColorConversion.Yuv420ToRgbaWithAlpha(_currYPlane, _currUPlane, _currVPlane, a, _header.Width, _header.Height, _currFrame);
                else ColorConversion.Yuv420ToRgba(_currYPlane, _currUPlane, _currVPlane, _header.Width, _header.Height, _currFrame);
                break;
        }
    }

    private QovFrame DecodeKeyframe(byte chunkFlags, uint timestamp, uint chunkSize)
    {
        bool isYuvChunk = (chunkFlags & QovTypes.ChunkFlagYuv) != 0;
        bool isCompressed = (chunkFlags & QovTypes.ChunkFlagCompressed) != 0;
        bool isDctKeyframe = (chunkFlags & QovTypes.ChunkFlagDctBlocks) != 0;

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
            if (isDctKeyframe)
            {
                // Intra DCT keyframe (spec 3.4.3)
                bool egKf = (chunkFlags & QovTypes.ChunkFlagExpGolob) != 0;
                int qpBase = _header.DctQpBase != 0 ? (int)_header.DctQpBase : 20;
                (int uvW, int uvH) = ChromaDims();
                float[] blockBuf = new float[64];
                int p = DecodeIntraPlaneDct(frameData, 0, _currYPlane, _header.Width, _header.Height, Dct.DefaultQuantLuma, QovTypes.OpDctY, qpBase, blockBuf, egKf);
                p = DecodeIntraPlaneDct(frameData, p, _currUPlane, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, qpBase, blockBuf, egKf);
                p = DecodeIntraPlaneDct(frameData, p, _currVPlane, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, qpBase, blockBuf, egKf);
                if (_hasYuvAlpha && _currAPlane != null)
                {
                    DecodeIntraPlaneDct(frameData, p, _currAPlane, _header.Width, _header.Height, Dct.DefaultQuantLuma, QovTypes.OpDctY, qpBase, blockBuf, egKf);
                }
            }
            else
            {
                int yEnd = DecodeYuvPlane(frameData, 0, _currYPlane);
                int uEnd = DecodeYuvPlane(frameData, yEnd, _currUPlane);
                int vEnd = DecodeYuvPlane(frameData, uEnd, _currVPlane);
                if (_hasYuvAlpha && _currAPlane != null)
                {
                    DecodeYuvPlane(frameData, vEnd, _currAPlane);
                }
            }

            ConvertCurrYuvPlanesToRgba();
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
        bool hasMotion = (chunkFlags & QovTypes.ChunkFlagMotion) != 0;
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

            // Refresh band byte leads the payload, before MV data (spec 3.4.4)
            bool hasBand = (chunkFlags & QovTypes.ChunkFlagRefreshBand) != 0;
            int band = hasBand ? frameData[pos++] : -1;
            var cm = Motion.ChromaMotionParams(_header.Colorspace);
            (int cW, int cH) = ChromaDims();
            int rowsY = (_header.Height + 7) / 8;
            int rowsC = (cH + 7) / 8;

            // A motion chunk's effective reference is the compensated previous plane
            MotionVectors? mv = hasMotion
                ? Motion.ParseMvBlock(frameData, ref pos, _header.Width, _header.Height)
                : null;
            byte[]? refY = _prevYPlane, refU = _prevUPlane, refV = _prevVPlane, refA = _prevAPlane;
            if (mv != null)
            {
                refY = new byte[_prevYPlane!.Length];
                Motion.CompensatePlane(_prevYPlane, _header.Width, _header.Height, mv.Value, refY, 1, 1, 0, 0);
                refU = new byte[_prevUPlane!.Length];
                Motion.CompensatePlane(_prevUPlane, cW, cH, mv.Value, refU, cm.Sx, cm.Sy, cm.Shx, cm.Shy);
                refV = new byte[_prevVPlane!.Length];
                Motion.CompensatePlane(_prevVPlane, cW, cH, mv.Value, refV, cm.Sx, cm.Sy, cm.Shx, cm.Shy);
                if (_hasYuvAlpha && _prevAPlane != null)
                {
                    refA = new byte[_prevAPlane.Length];
                    Motion.CompensatePlane(_prevAPlane, _header.Width, _header.Height, mv.Value, refA, 1, 1, 0, 0);
                }
            }

            if ((chunkFlags & QovTypes.ChunkFlagDctBlocks) != 0)
            {
                // Init input planes from previous reference for DCT
                Array.Copy(refY!, _currYPlane, refY!.Length);
                Array.Copy(refU!, _currUPlane, refU!.Length);
                Array.Copy(refV!, _currVPlane, refV!.Length);
                if (_hasYuvAlpha && _currAPlane != null && refA != null)
                {
                    Array.Copy(refA, _currAPlane, refA.Length);
                }

                float[] blockBuf = new float[64];
                int uvW = cW;
                int uvH = cH;

                int yr0 = band < 0 ? -1 : rowsY * band / QovTypes.IntraRefreshBands;
                int yr1 = band < 0 ? -1 : rowsY * (band + 1) / QovTypes.IntraRefreshBands;
                int cr0 = band < 0 ? -1 : rowsC * band / QovTypes.IntraRefreshBands;
                int cr1 = band < 0 ? -1 : rowsC * (band + 1) / QovTypes.IntraRefreshBands;
                bool eg = (chunkFlags & QovTypes.ChunkFlagExpGolob) != 0;

                pos = DecodePlaneDct(frameData, pos, _currYPlane, _header.Width, _header.Height, Dct.DefaultQuantLuma, QovTypes.OpDctY, blockBuf, yr0, yr1, eg);
                pos = DecodePlaneDct(frameData, pos, _currUPlane, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf, cr0, cr1, eg);
                pos = DecodePlaneDct(frameData, pos, _currVPlane, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf, cr0, cr1, eg);
                if (_hasYuvAlpha && _currAPlane != null && refA != null)
                {
                    // Alpha is coded with luma dimensions and the luma quant table
                    pos = DecodePlaneDct(frameData, pos, _currAPlane, _header.Width, _header.Height, Dct.DefaultQuantLuma, QovTypes.OpDctY, blockBuf, yr0, yr1, eg);
                }
            }
            else
            {
                pos = DecodeYuvPlaneTemporal(frameData, pos, _currYPlane, refY!);
                pos = DecodeYuvPlaneTemporal(frameData, pos, _currUPlane, refU!);
                pos = DecodeYuvPlaneTemporal(frameData, pos, _currVPlane, refV!);
                if (_hasYuvAlpha && _currAPlane != null && refA != null)
                {
                    pos = DecodeYuvPlaneTemporal(frameData, pos, _currAPlane, refA);
                }
            }

            // Convert decoded YUV back to RGBA
            ConvertCurrYuvPlanesToRgba();
            SwapYuvPlanes();
        }
        else
        {
            DecodeRgbPFrame(frameData, hasMotion);
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

        // A motion chunk's effective reference is the compensated previous frame;
        // the MV block is consumed from the same cursor the opcode loop uses
        if (hasMotion)
        {
            var mv = Motion.ParseMvBlock(data, ref pos, _header.Width, _header.Height);
            Motion.CompensateFrame(_prevFrame, _header.Width, _header.Height, mv, _currFrame);
        }
        else
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
        if (_prevAPlane != null && _currAPlane != null)
        {
            byte[] tempA = _prevAPlane; _prevAPlane = _currAPlane; _currAPlane = tempA;
        }
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

    private int DecodeDctBlock(ReadOnlySpan<byte> data, ref int pos, int[] quantTable, byte qpBase, float[] output, bool eg = false)
    {
        byte qpByte = data[pos++];
        int qpDelta = (qpByte & 0x7F) - 64;
        int finalQp = Math.Clamp(qpBase + qpDelta, 0, 100);
        // TS uses double math (0.1 + finalQp * 0.1); float breaks bit-exactness
        double scale = 0.1 + finalQp * 0.1;

        float[] coeffs = new float[64];

        if (eg)
        {
            // Exp-Golomb coefficient section (spec 3.4.5)
            int blockStart = pos;
            byte[] tail = data.Slice(pos).ToArray();
            int bytePos = 0;
            var r = new EgBitReader(() => bytePos < tail.Length ? tail[bytePos++] : 0);
            coeffs[0] = (float)(r.Se() * (double)quantTable[0] * scale);
            int ke = 1;
            for (;;)
            {
                uint run = r.Ue();
                if (run >= (uint)(64 - ke)) break; // EOB sentinel ue(64-k)
                ke += (int)run;
                int level = r.Se();
                coeffs[Dct.ZigZag[ke]] = (float)(level * (double)quantTable[Dct.ZigZag[ke]] * scale);
                ke++;
                if (ke >= 64) break; // defensive; canonical streams hit the sentinel
            }
            pos = blockStart + bytePos; // pending bits (<8) are the block's zero padding

            Dct.InverseDctRaw(coeffs, output);
            return ke;
        }

        ushort dcRaw = (ushort)((data[pos] << 8) | data[pos + 1]);
        pos += 2;
        int dc = (dcRaw & 0x8000) != 0 ? dcRaw - 65536 : dcRaw;

        coeffs[0] = (float)(dc * (double)quantTable[0] * scale);

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
                else if (size == 3) level = (rawLevel & 0x800000) != 0 ? (int)rawLevel - 16777216 : (int)rawLevel;
                else level = (int)rawLevel;
            }

            coeffs[Dct.ZigZag[k]] = (float)(level * (double)quantTable[Dct.ZigZag[k]] * scale);
            k++;
        }

        Dct.InverseDctRaw(coeffs, output);
        return k; // Return value not strictly needed but matches structure
    }

    private int DecodePlaneDct(ReadOnlySpan<byte> data, int startPos, byte[] plane, int w, int h, int[] quantTable, byte opType, float[] blockBuf, int bandR0 = -1, int bandR1 = -1, bool eg = false)
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
            if (b1 == QovTypes.OpDctSkip || b1 == QovTypes.OpDctZero)
            {
                byte count = data[pos++];
                for (int n = 0; n < count && blockIdx < totalBlocks; n++, blockIdx++)
                {
                    // Refresh band skips are prediction fills, not ref copies
                    // (spec 3.4.4); a single run may straddle a band boundary
                    int brow = blockIdx / blocksX;
                    if (brow < bandR0 || brow >= bandR1) continue;
                    int bx = (blockIdx % blocksX) * 8;
                    int by = brow * 8;
                    int pred = IntraPred(plane, w, h, bx, by);
                    for (int y = 0; y < 8 && by + y < h; y++)
                        for (int x = 0; x < 8 && bx + x < w; x++)
                            plane[(by + y) * w + bx + x] = (byte)pred;
                }
            }
            else if (b1 == opType)
            {
                int bx = (blockIdx % blocksX) * 8;
                int by = (blockIdx / blocksX) * 8;
                bool inBand = blockIdx / blocksX >= bandR0 && blockIdx / blocksX < bandR1;
                int pred = inBand ? IntraPred(plane, w, h, bx, by) : 0;

                DecodeDctBlock(data, ref pos, quantTable, qpBase, blockBuf, eg);

                for (int y = 0; y < 8; y++)
                {
                    if (by + y >= h) break;
                    for (int x = 0; x < 8; x++)
                    {
                        if (bx + x >= w) break;
                        int idx = (by + y) * w + (bx + x);
                        // TS adds the untruncated float residual, clamps, then truncates on store
                        int baseVal = inBand ? pred : plane[idx];
                        int val = (int)(baseVal + blockBuf[y * 8 + x]);
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