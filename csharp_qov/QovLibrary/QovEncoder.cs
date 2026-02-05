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
    private readonly QoaEncoder? _qoaEncoder;

    public QovEncoder(Stream output, ushort width, ushort height,
        ushort frameRateNum = 30, ushort frameRateDen = 1,
        byte flags = QovTypes.FlagHasIndex,
        byte colorspace = QovTypes.ColorspaceSrgb,
        bool useCompression = true,
        int quality = 0,
        int audioChannels = 0,
        int audioRate = 0)
    {
        // Lossy logic
        if (quality > 0 && quality < 100)
        {
            flags |= QovTypes.FlagLossyMode;
            flags |= QovTypes.FlagDctEnabled; // Enable DCT by default for lossy
        }
        

        byte version = (flags & QovTypes.FlagLossyMode) != 0 ? QovTypes.Version3 : QovTypes.Version2;
        LossyParams lp = LossyParams.Derive(quality);

        _writer = new BinaryWriter(output, System.Text.Encoding.ASCII, leaveOpen: true);
        _header = new QovHeader(flags, width, height, frameRateNum, frameRateDen, colorspace,
            (byte)audioChannels, (uint)audioRate, 0, 
            (byte)quality, lp.YQuant, lp.UvQuant, lp.TemporalThresh, lp.DctQp, version);
            
        if (audioChannels > 0 && audioRate > 0)
        {
            _qoaEncoder = new QoaEncoder(audioChannels, audioRate);
        }
            
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
        _writer.Write(_header.Version);

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

        // Audio fields
        _writer.Write(_header.AudioChannels);
        WriteBigEndian24(_header.AudioRate);

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
    }

    public void EncodeAudio(ReadOnlySpan<float> samples, uint timestamp)
    {
        if (_qoaEncoder == null) return;
        
        byte[] encodedData = _qoaEncoder.EncodeFrame(samples);
        
        _writer.Write(QovTypes.ChunkTypeAudio);
        _writer.Write((byte)0); // flags
        WriteBigEndian((uint)encodedData.Length);
        WriteBigEndian(timestamp);
        _writer.Write(encodedData);
    }
    
    private void WriteBigEndian24(uint value)
    {
        _writer.Write((byte)((value >> 16) & 0xff));
        _writer.Write((byte)((value >> 8) & 0xff));
        _writer.Write((byte)(value & 0xff));
    }

    private void EncodeRgbKeyframe(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        // Update previous frame buffer (lossless)
        pixels.CopyTo(_prevFrame);

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
        // Update previous frame buffer (lossless/YUV approximation ignored for now? No, need copy)
        // If YUV is lossless, we can copy data.
        // QOV YUV usually implies some loss due to conversion, but we store RGB in _prevFrame.
        // So copying pixels is "correct" for reference if we assume lossless encoding.
        // But if we want to simulate YUV loss, we should convert back.
        // For Keyframe, we just store original.
        pixels.CopyTo(_prevFrame);

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
    }

    private void EncodeRgbPFrame(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        pixels.CopyTo(_prevFrame);
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
        int width = _header.Width;
        int height = _header.Height;
        bool useDct = (_header.Flags & QovTypes.FlagDctEnabled) != 0;

        ColorConversion.RgbaToYuv420(pixels, width, height,
            out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        ColorConversion.RgbaToYuv420(_prevFrame, width, height,
            out byte[] prevY, out byte[] prevU, out byte[] prevV);

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);

        if (useDct)
        {
            float[] blockBuf = new float[64];
            byte[] nextY = new byte[yPlane.Length];
            byte[] nextU = new byte[uPlane.Length];
            byte[] nextV = new byte[vPlane.Length];

            EncodePlaneDct(yPlane, prevY, nextY, width, height, Dct.DefaultQuantLuma, QovTypes.OpDctY, blockBuf, tempWriter);
            
            // Chroma subsampling dims
            int uvW = (width + 1) / 2;
            int uvH = (height + 1) / 2;
            
            EncodePlaneDct(uPlane, prevU, nextU, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf, tempWriter);
            EncodePlaneDct(vPlane, prevV, nextV, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf, tempWriter);

            // Reconstruct _prevFrame from nextY/U/V to avoid drift
            // We need a way to convert YUV planes back to RGBA into _prevFrame
            ColorConversion.Yuv420ToRgba(nextY, nextU, nextV, width, height, _prevFrame);

            byte[] frameData = tempStream.ToArray();
            WriteChunk(QovTypes.ChunkTypePframe, (byte)(QovTypes.ChunkFlagYuv | QovTypes.ChunkFlagDctBlocks), timestamp, frameData, false);
        }
        else
        {
            EncodeYuvPlaneTemporal(yPlane, prevY, tempWriter);
            EncodeYuvPlaneTemporal(uPlane, prevU, tempWriter);
            EncodeYuvPlaneTemporal(vPlane, prevV, tempWriter);

            // In legacy DPCM mode, we assume drift is negligible or handled by I-frames?
            // Actually, we should probably update _prevFrame using the decoded result too,
            // but DPCM is lossless (except for conversion).
            // But we already removed the global copy. So we MUST update _prevFrame here.
            // Since DPCM is technically lossless (modulo quantization if implemented), 
            // and we rely on ColorConversion which is lossy (rounding), 
            // it's safest to overwrite _prevFrame with the Input pixels for DPCM 
            // OR use the YUV decoded.
            // For now, to match previous behavior, I will copy Input pixels.
            // Note: This reintroduced the "copy" behavior I removed, but only for DPCM path.
            pixels.CopyTo(_prevFrame);

            byte[] frameData = tempStream.ToArray();
            WriteChunk(QovTypes.ChunkTypePframe, QovTypes.ChunkFlagYuv, timestamp, frameData, false);
        }
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
        // Initialize to -1 to prevent false matches with value 0 (critical for YUV)
        Array.Fill(index, -1);
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


    private void EncodePlaneDct(ReadOnlySpan<byte> curr, ReadOnlySpan<byte> prev, Span<byte> next, int width, int height, int[] quant, byte opType, float[] blockBuf, BinaryWriter writer)
    {
        int qpBase = _header.DctQpBase;
        int blocksX = (width + 7) / 8;
        int blocksY = (height + 7) / 8;
        int skipCount = 0;

        for (int by = 0; by < blocksY; by++)
        {
            for (int bx = 0; bx < blocksX; bx++)
            {
                // 1. Extract Block & Calculate Residual
                bool hasContent = false;
                float diffSum = 0;
                
                for (int y = 0; y < 8; y++)
                {
                    int py = by * 8 + y;
                    if (py >= height) continue;
                    for (int x = 0; x < 8; x++)
                    {
                        int px = bx * 8 + x;
                        if (px >= width) continue;
                        
                        int idx = py * width + px;
                        float res = curr[idx] - prev[idx];
                        blockBuf[y * 8 + x] = res;
                        diffSum += Math.Abs(res);
                    }
                }

                // 2. Threshold check
                if (diffSum < 64) hasContent = false;
                else hasContent = true;

                if (!hasContent)
                {
                    skipCount++;
                    // Reconstruct: just copy previous
                    for (int y = 0; y < 8; y++)
                    {
                        int py = by * 8 + y;
                        if (py >= height) continue;
                        for (int x = 0; x < 8; x++)
                        {
                            int px = bx * 8 + x;
                            if (px >= width) continue;
                            int idx = py * width + px;
                            next[idx] = prev[idx];
                        }
                    }
                    continue;
                }

                // Flush skips
                while (skipCount > 0)
                {
                    writer.Write(QovTypes.OpDctSkip);
                    byte count = (byte)Math.Min(skipCount, 255);
                    writer.Write(count);
                    skipCount -= count;
                }

                // 3. DCT Transform
                float[] coeffs = new float[64];
                Dct.ForwardDct(blockBuf, coeffs);

                // 4. Quantize
                float scale = 1.0f / (0.1f + (qpBase * 0.1f));
                
                writer.Write(opType);
                writer.Write((byte)0x40); // Delta 0

                // DC
                short dcVal = (short)Math.Round(coeffs[0] * scale / quant[0]);
                writer.Write(dcVal);
                
                // AC
                int zeroRun = 0;
                for (int k = 1; k < 64; k++)
                {
                    int zigzagIdx = Dct.ZigZag[k];
                    float coeff = coeffs[zigzagIdx];
                    int qVal = (int)Math.Round(coeff * scale / quant[zigzagIdx]);
                    
                    if (qVal == 0)
                    {
                        zeroRun++;
                    }
                    else
                    {
                        // Write run/level
                        while (zeroRun >= 16)
                        {
                            writer.Write((byte)0xF0);
                            zeroRun -= 16;
                        }
                        
                        int size = 0;
                        if (qVal >= -128 && qVal <= 127) size = 1;
                        else if (qVal >= -32768 && qVal <= 32767) size = 2;
                        else if (qVal >= -8388608 && qVal <= 8388607) size = 3;
                        else size = 4;
                        
                        writer.Write((byte)((zeroRun << 4) | size));
                        
                        if (size == 1) writer.Write((byte)qVal);
                        else if (size == 2) writer.Write((short)qVal);
                        else if (size == 3) {
                             writer.Write((byte)((qVal >> 16) & 0xff));
                             writer.Write((byte)((qVal >> 8) & 0xff));
                             writer.Write((byte)(qVal & 0xff));
                        }
                        else writer.Write(qVal);
                        
                        zeroRun = 0;
                    }
                }
                writer.Write((byte)0x00); // EOB

                // 5. Reconstruct
                float[] recCoeffs = new float[64];
                recCoeffs[0] = (float)Math.Round(coeffs[0] * scale / quant[0]) * quant[0] / scale;
                for (int k = 1; k < 64; k++)
                {
                     int z = Dct.ZigZag[k];
                     float qVal = (float)Math.Round(coeffs[z] * scale / quant[z]);
                     recCoeffs[z] = qVal * quant[z] / scale;
                }
                
                // IDCT
                Dct.InverseDctRaw(recCoeffs, blockBuf); 
                
                // Add to prev and store in next
                for (int y = 0; y < 8; y++)
                {
                    int py = by * 8 + y;
                    if (py >= height) continue;
                    for (int x = 0; x < 8; x++)
                    {
                        int px = bx * 8 + x;
                        if (px >= width) continue;
                        
                        int idx = py * width + px;
                        float res = blockBuf[y * 8 + x];
                        int val = (int)(prev[idx] + res);
                        next[idx] = (byte)Math.Max(0, Math.Min(255, val));
                    }
                }
            }
        }
        
        // Flush final skips
        while (skipCount > 0)
        {
            writer.Write(QovTypes.OpDctSkip);
            byte count = (byte)Math.Min(skipCount, 255);
            writer.Write(count);
            skipCount -= count;
        }
    }

    private void EncodeYuvPlaneTemporal(ReadOnlySpan<byte> plane, ReadOnlySpan<byte> prevPlane, BinaryWriter writer)
    {
        int size = plane.Length;
        int[] index = new int[64];
        // Initialize to -1 to prevent false matches with value 0 (critical for YUV)
        Array.Fill(index, -1);
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