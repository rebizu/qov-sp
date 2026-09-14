namespace QovLibrary;

/// <summary>
/// QOV Encoder - encodes RGBA frames to QOV format with temporal compression.
/// </summary>
public class QovEncoder
{
    private readonly BinaryWriter _writer;
    private readonly QovHeader _header;
    private readonly byte[] _prevFrame;
    private byte[]? _prevYPlane;
    private byte[]? _prevUPlane;
    private byte[]? _prevVPlane;
    private byte[]? _prevAPlane;
    private readonly QovPixel[] _colorIndex;
    private readonly QovPixel[] _colorCache;
    private QovPixel _prevPixel;
    private readonly List<QovIndexEntry> _keyframes;
    private int _frameCount;
    private bool _hasPrevFrame;
    private readonly bool _isYuvMode;
    private readonly bool _hasAlpha;
    private readonly bool _useCompression;
    private readonly bool _lossyMode;
    private readonly bool _intraDctKeyframes;
    private readonly bool _intraRefresh;
    private readonly LossyParams _lossyParams;
    private readonly bool _motionEnabled;
    private readonly QoaEncoder? _qoaEncoder;
    private bool _isFinished;

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
        else
        {
            flags = (byte)(flags & ~QovTypes.FlagIntraRefresh); // refresh bands are lossy-only
        }
        

        byte version = (flags & QovTypes.FlagLossyMode) != 0 ? QovTypes.Version3 : QovTypes.Version2;
        LossyParams lp = LossyParams.Derive(quality);
        _lossyMode = quality > 0 && quality < 100;
        _intraDctKeyframes = (flags & QovTypes.FlagIntraDctKf) != 0;
        _intraRefresh = (flags & QovTypes.FlagIntraRefresh) != 0;
        _lossyParams = _lossyMode ? lp : default;
        _motionEnabled = (flags & QovTypes.FlagHasMotion) != 0;

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
        _isFinished = false;
        _hasPrevFrame = false;
 
        _isYuvMode = colorspace >= QovTypes.ColorspaceYuv420;
        _hasAlpha = (flags & QovTypes.FlagHasAlpha) != 0 || colorspace == QovTypes.ColorspaceYuva420;

        if (_isYuvMode)
        {
            int pixelCount = width * height;
            int uvWidth = (colorspace == QovTypes.ColorspaceYuv444) ? width : (width + 1) / 2;
            int uvHeight = (colorspace == QovTypes.ColorspaceYuv444) ? height
                         : (colorspace == QovTypes.ColorspaceYuv422) ? height : (height + 1) / 2;
            int uvSize = uvWidth * uvHeight;
            _prevYPlane = new byte[pixelCount];
            _prevUPlane = new byte[uvSize];
            _prevVPlane = new byte[uvSize];
            if (_hasAlpha)
            {
                _prevAPlane = new byte[pixelCount];
            }
        }

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

        // Colorspace and quality
        _writer.Write(_header.Colorspace);
        _writer.Write(_header.Quality);

        // Extended Header (Version 0x03 only)
        if (_header.Version == QovTypes.Version3)
        {
            _writer.Write(_header.YQuantBase);
            _writer.Write(_header.UvQuantBase);
            _writer.Write(_header.TemporalThresh);
            _writer.Write(_header.DctQpBase);
            _writer.Write(0u); // 4 bytes reserved (BinaryWriter.Write(uint) is little-endian, but it is reserved)
            // Wait, spec says reserved 0x00000000. 
            // Better write 4 bytes of 0 explicitly to be safe about endianness of reserved bytes
            // though 0 is 0.
        }
    }

    public void EncodeKeyframe(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        if (_isFinished) return;
        _hasPrevFrame = true;
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
        if (_isFinished || _qoaEncoder == null) return;
        
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
        if (_isFinished) return;

        int frameNumber = _frameCount++;
        int pixelCount = _header.Width * _header.Height;
        byte[]? quantizedFrame = _lossyMode ? new byte[pixels.Length] : null;

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
            // Apply lossy quantization if enabled
            QovPixel current = QuantizePixel(new QovPixel(pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]));

            // Store quantized pixel for P-frame reference
            if (quantizedFrame != null)
            {
                quantizedFrame[idx] = current.R;
                quantizedFrame[idx + 1] = current.G;
                quantizedFrame[idx + 2] = current.B;
                quantizedFrame[idx + 3] = current.A;
            }

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

        tempWriter.Flush();
        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypeKeyframe, 0, timestamp, frameData, true);

        // Reference: quantized pixels in lossy mode (decoder reconstructs quantized)
        if (quantizedFrame != null) quantizedFrame.AsSpan().CopyTo(_prevFrame.AsSpan());
        else pixels.CopyTo(_prevFrame.AsSpan());
    }

    // ---- Lossy quantization (mirrors TS quantizePlane/quantizePixel exactly) ----

    private static int QuantizePlaneValue(int value, int quantStep)
    {
        if (quantStep <= 1) return value;
        return Math.Clamp(ColorConversion.JsRound(value / (double)quantStep) * quantStep, 0, 255);
    }

    private byte[]? QuantizePlane(byte[]? plane, int quantStep)
    {
        if (!_lossyMode || quantStep <= 1 || plane == null) return plane;
        var result = new byte[plane.Length];
        for (int i = 0; i < plane.Length; i++) result[i] = (byte)QuantizePlaneValue(plane[i], quantStep);
        return result;
    }

    private QovPixel QuantizePixel(QovPixel c)
    {
        if (!_lossyMode) return c;
        int yQuant = _lossyParams.YQuant;
        int uvQuant = _lossyParams.UvQuant;

        // Integer fixed-point BT.709-style transform; floor divisions on
        // possibly-negative numerators must be true floors (TS Math.floor)
        double y = Math.Floor((66 * c.R + 129 * c.G + 25 * c.B + 128) / 256.0);
        double cb = Math.Floor((-38 * c.R - 74 * c.G + 112 * c.B + 128) / 256.0);
        double cr = Math.Floor((112 * c.R - 94 * c.G - 18 * c.B + 128) / 256.0);

        y += 16; cb += 128; cr += 128;

        y = ColorConversion.JsRound(y / yQuant) * yQuant;
        cb = ColorConversion.JsRound(cb / uvQuant) * uvQuant;
        cr = ColorConversion.JsRound(cr / uvQuant) * uvQuant;

        double cy = y - 16;
        double d = cb - 128;
        double e = cr - 128;

        return new QovPixel(
            (byte)Math.Clamp(Math.Floor((298 * cy + 409 * e + 128) / 256.0), 0, 255),
            (byte)Math.Clamp(Math.Floor((298 * cy - 100 * d - 208 * e + 128) / 256.0), 0, 255),
            (byte)Math.Clamp(Math.Floor((298 * cy + 516 * d + 128) / 256.0), 0, 255),
            c.A);
    }

    private static bool ValuesAreSimilar(int a, int b, int threshold)
        => Math.Abs(a - b) <= threshold;

    private static bool PixelsAreSimilar(QovPixel c, QovPixel r, int threshold)
        => ValuesAreSimilar(c.R, r.R, threshold)
        && ValuesAreSimilar(c.G, r.G, threshold)
        && ValuesAreSimilar(c.B, r.B, threshold)
        && ValuesAreSimilar(c.A, r.A, (int)Math.Floor(threshold / 2.0));

    // Chroma plane dims per header colorspace (spec: 444→w×h, 422→⌈w/2⌉×h, else ⌈w/2⌉×⌈h/2⌉)
    private (int W, int H) ChromaDims()
    {
        return _header.Colorspace switch
        {
            QovTypes.ColorspaceYuv444 => (_header.Width, _header.Height),
            QovTypes.ColorspaceYuv422 => ((_header.Width + 1) / 2, _header.Height),
            _ => ((_header.Width + 1) / 2, (_header.Height + 1) / 2),
        };
    }

    private void RgbaToYuvPlanes(ReadOnlySpan<byte> pixels, int width, int height,
        out byte[] yPlane, out byte[] uPlane, out byte[] vPlane)
    {
        switch (_header.Colorspace)
        {
            case QovTypes.ColorspaceYuv444:
                ColorConversion.RgbaToYuv444(pixels, width, height, out yPlane, out uPlane, out vPlane);
                break;
            case QovTypes.ColorspaceYuv422:
                ColorConversion.RgbaToYuv422(pixels, width, height, out yPlane, out uPlane, out vPlane);
                break;
            default:
                ColorConversion.RgbaToYuv420(pixels, width, height, out yPlane, out uPlane, out vPlane);
                break;
        }
    }

    private void YuvPlanesToRgba(byte[] yPlane, byte[] uPlane, byte[] vPlane, Span<byte> output)
    {
        switch (_header.Colorspace)
        {
            case QovTypes.ColorspaceYuv444:
                ColorConversion.Yuv444ToRgba(yPlane, uPlane, vPlane, _header.Width, _header.Height, output);
                break;
            case QovTypes.ColorspaceYuv422:
                ColorConversion.Yuv422ToRgba(yPlane, uPlane, vPlane, _header.Width, _header.Height, output);
                break;
            default:
                ColorConversion.Yuv420ToRgba(yPlane, uPlane, vPlane, _header.Width, _header.Height, output);
                break;
        }
    }

    private void EncodeYuvKeyframe(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        // For Keyframe, we just store original.
        pixels.CopyTo(_prevFrame.AsSpan());

        int frameNumber = _frameCount++;
        int width = _header.Width;
        int height = _header.Height;
        int pixelCount = width * height;

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

        RgbaToYuvPlanes(pixels, width, height, out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        // Alpha extraction for the P-frame reference / alpha plane coding
        if (_prevAPlane != null)
        {
            for (int i = 0; i < pixelCount; i++) _prevAPlane[i] = pixels[i * 4 + 3];
        }

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);

        byte chunkFlags = QovTypes.ChunkFlagYuv;
        if (_lossyMode && _intraDctKeyframes)
        {
            // PR3 intra DCT keyframe (spec 3.4.3): DC-predicted 8x8 blocks;
            // the plane buffers end up holding the decoder-side reconstruction
            chunkFlags |= QovTypes.ChunkFlagDctBlocks;
            (int kfUvW, int kfUvH) = ChromaDims();
            EncodeIntraPlaneDct(yPlane, width, height, Dct.DefaultQuantLuma, QovTypes.OpDctY, tempWriter);
            EncodeIntraPlaneDct(uPlane, kfUvW, kfUvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, tempWriter);
            EncodeIntraPlaneDct(vPlane, kfUvW, kfUvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, tempWriter);
            if (_prevAPlane != null)
            {
                EncodeIntraPlaneDct(_prevAPlane, width, height, Dct.DefaultQuantLuma, QovTypes.OpDctY, tempWriter);
            }
        }
        else
        {
            if (_lossyMode)
            {
                yPlane = QuantizePlane(yPlane, _lossyParams.YQuant)!;
                uPlane = QuantizePlane(uPlane, _lossyParams.UvQuant)!;
                vPlane = QuantizePlane(vPlane, _lossyParams.UvQuant)!;
            }
            EncodeYuvPlane(yPlane, tempWriter);
            EncodeYuvPlane(uPlane, tempWriter);
            EncodeYuvPlane(vPlane, tempWriter);

            if (_prevAPlane != null)
            {
                EncodeYuvPlane(_prevAPlane, tempWriter);
            }
        }

        // Store planes for P-frame reference (reconstructed values when lossy)
        yPlane.AsSpan().CopyTo(_prevYPlane.AsSpan()!);
        uPlane.AsSpan().CopyTo(_prevUPlane.AsSpan()!);
        vPlane.AsSpan().CopyTo(_prevVPlane.AsSpan()!);

        // Write end marker
        for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
        tempWriter.Write((byte)1);

        tempWriter.Flush();
        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypeKeyframe, chunkFlags, timestamp, frameData, true);
    }

    public void EncodePFrame(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        if (_isFinished) return;
        if (!_hasPrevFrame)
        {
            EncodeKeyframe(pixels, timestamp);
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
        int frameNumber = _frameCount++;
        int pixelCount = _header.Width * _header.Height;
        int temporalThresh = _lossyMode ? _lossyParams.TemporalThresh : 0;
        byte[]? quantizedFrame = _lossyMode ? new byte[pixels.Length] : null;

        // Motion estimation on luma vs the reference frame
        MotionVectors? mv = null;
        byte[] refFrame = _prevFrame;
        if (_motionEnabled)
        {
            var currLuma = new byte[pixelCount];
            var prevLuma = new byte[pixelCount];
            for (int i = 0; i < pixelCount; i++)
            {
                int o = i * 4;
                currLuma[i] = (byte)((pixels[o] * 299 + pixels[o + 1] * 587 + pixels[o + 2] * 114) / 1000);
                prevLuma[i] = (byte)((refFrame[o] * 299 + refFrame[o + 1] * 587 + refFrame[o + 2] * 114) / 1000);
            }
            mv = Motion.EstimateMotion(currLuma, prevLuma, _header.Width, _header.Height,
                temporalThresh > 0 ? temporalThresh * 5 : 0,
                _lossyMode,
                Math.Max(4, (int)Math.Ceiling(0.005 * ((_header.Width + 15) / 16) * ((_header.Height + 15) / 16))));
            if (mv != null)
            {
                var comp = new byte[refFrame.Length];
                Motion.CompensateFrame(refFrame, _header.Width, _header.Height, mv.Value, comp);
                refFrame = comp;
            }
        }
        int motionFlag = mv != null ? QovTypes.ChunkFlagMotion : 0;

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);
        if (mv != null) Motion.WriteMvBlock(mv.Value, tempWriter);

        int skipCount = 0;
        QovPixel prevPixel = new QovPixel(0, 0, 0, 255);

        for (int px = 0; px < pixelCount; px++)
        {
            int idx = px * 4;
            // Apply lossy quantization if enabled
            QovPixel current = QuantizePixel(new QovPixel(pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]));
            QovPixel prev = new QovPixel(refFrame[idx], refFrame[idx + 1], refFrame[idx + 2], refFrame[idx + 3]);

            // Check if pixel unchanged from reference (or similar enough in lossy mode)
            bool isSimilar = temporalThresh > 0
                ? PixelsAreSimilar(current, prev, temporalThresh)
                : QovPixel.Equals(current, prev);

            if (isSimilar)
            {
                // Decoder retains the reference pixel when skipping, so store ref
                if (quantizedFrame != null)
                {
                    quantizedFrame[idx] = prev.R;
                    quantizedFrame[idx + 1] = prev.G;
                    quantizedFrame[idx + 2] = prev.B;
                    quantizedFrame[idx + 3] = prev.A;
                }
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

            // Store quantized pixel for next P-frame reference
            if (quantizedFrame != null)
            {
                quantizedFrame[idx] = current.R;
                quantizedFrame[idx + 1] = current.G;
                quantizedFrame[idx + 2] = current.B;
                quantizedFrame[idx + 3] = current.A;
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

        // Update previous frame buffer after encoding loop
        // (quantized pixels in lossy mode — reference matches decoder reconstruction)
        if (quantizedFrame != null) quantizedFrame.AsSpan().CopyTo(_prevFrame.AsSpan());
        else pixels.CopyTo(_prevFrame.AsSpan());


        // Write end marker
        for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
        tempWriter.Write((byte)1);

        tempWriter.Flush();
        byte[] frameData = tempStream.ToArray();
        WriteChunk(QovTypes.ChunkTypePframe, (byte)motionFlag, timestamp, frameData, false);
    }

    private void EncodeYuvPFrame(ReadOnlySpan<byte> pixels, uint timestamp)
    {
        int frameNumber = _frameCount++;
        int width = _header.Width;
        int height = _header.Height;
        bool useDct = (_header.Flags & QovTypes.FlagDctEnabled) != 0;

        RgbaToYuvPlanes(pixels, width, height, out byte[] yPlane, out byte[] uPlane, out byte[] vPlane);

        // Apply lossy quantization if enabled
        if (_lossyMode)
        {
            yPlane = QuantizePlane(yPlane, _lossyParams.YQuant)!;
            uPlane = QuantizePlane(uPlane, _lossyParams.UvQuant)!;
            vPlane = QuantizePlane(vPlane, _lossyParams.UvQuant)!;
        }

        byte[]? aPlane = null;
        if (_prevAPlane != null)
        {
            aPlane = new byte[width * height];
            for (int i = 0; i < aPlane.Length; i++) aPlane[i] = pixels[i * 4 + 3];
            aPlane = QuantizePlane(aPlane, _lossyParams.YQuant);
        }

        // Motion estimation on the quantized luma plane vs the stored reference
        MotionVectors? mv = null;
        byte[] refY = _prevYPlane!, refU = _prevUPlane!, refV = _prevVPlane!, refA = _prevAPlane!;
        if (_motionEnabled)
        {
            int temporalThresh = _lossyMode ? _lossyParams.TemporalThresh : 0;
            mv = Motion.EstimateMotion(yPlane, _prevYPlane!, width, height,
                temporalThresh > 0 ? temporalThresh * 5 : 0,
                _lossyMode,
                Math.Max(4, (int)Math.Ceiling(0.005 * ((width + 15) / 16) * ((height + 15) / 16))));
            if (mv != null)
            {
                var cm = Motion.ChromaMotionParams(_header.Colorspace);
                (int mvUvW, int mvUvH) = ChromaDims();
                refY = new byte[width * height];
                Motion.CompensatePlane(_prevYPlane!, width, height, mv.Value, refY, 1, 1, 0, 0);
                refU = new byte[_prevUPlane!.Length];
                Motion.CompensatePlane(_prevUPlane, mvUvW, mvUvH, mv.Value, refU, cm.Sx, cm.Sy, cm.Shx, cm.Shy);
                refV = new byte[_prevVPlane!.Length];
                Motion.CompensatePlane(_prevVPlane, mvUvW, mvUvH, mv.Value, refV, cm.Sx, cm.Sy, cm.Shx, cm.Shy);
                if (aPlane != null && _prevAPlane != null)
                {
                    refA = new byte[_prevAPlane.Length];
                    Motion.CompensatePlane(_prevAPlane, width, height, mv.Value, refA, 1, 1, 0, 0);
                }
            }
        }
        int motionFlag = mv != null ? QovTypes.ChunkFlagMotion : 0;
        // Refresh band (spec 3.4.4): the band byte leads the payload, before MV data
        bool refresh = useDct && _intraRefresh;
        int band = refresh ? _frameCount % QovTypes.IntraRefreshBands : -1;
        int refreshFlag = refresh ? QovTypes.ChunkFlagRefreshBand : 0;

        using var tempStream = new MemoryStream();
        using var tempWriter = new BinaryWriter(tempStream);
        if (refresh) tempWriter.Write((byte)band);
        if (mv != null) Motion.WriteMvBlock(mv.Value, tempWriter);

        if (useDct)
        {
            float[] blockBuf = new float[64];
            byte[] nextY = new byte[yPlane.Length];
            byte[] nextU = new byte[uPlane.Length];
            byte[] nextV = new byte[vPlane.Length];

            // Chroma subsampling dims per header colorspace
            (int uvW, int uvH) = ChromaDims();

            // Band block rows per plane (spec 3.4.4)
            int rowsY = (height + 7) / 8, rowsC = (uvH + 7) / 8;
            int yr0 = band < 0 ? -1 : rowsY * band / QovTypes.IntraRefreshBands;
            int yr1 = band < 0 ? -1 : rowsY * (band + 1) / QovTypes.IntraRefreshBands;
            int cr0 = band < 0 ? -1 : rowsC * band / QovTypes.IntraRefreshBands;
            int cr1 = band < 0 ? -1 : rowsC * (band + 1) / QovTypes.IntraRefreshBands;

            EncodePlaneDct(yPlane, refY, nextY, width, height, Dct.DefaultQuantLuma, QovTypes.OpDctY, blockBuf, tempWriter, yr0, yr1);

            EncodePlaneDct(uPlane, refU, nextU, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf, tempWriter, cr0, cr1);
            EncodePlaneDct(vPlane, refV, nextV, uvW, uvH, Dct.DefaultQuantChroma, QovTypes.OpDctUv, blockBuf, tempWriter, cr0, cr1);

            if (aPlane != null && refA != null)
            {
                // Alpha is coded as a luma table plane (spec v3.2 §3.4.2)
                byte[] nextA = new byte[aPlane.Length];
                EncodePlaneDct(aPlane, refA, nextA, width, height, Dct.DefaultQuantLuma, QovTypes.OpDctY, blockBuf, tempWriter, yr0, yr1);
                nextA.AsSpan().CopyTo(_prevAPlane.AsSpan());
            }

            // Update persistent planes
            nextY.AsSpan().CopyTo(_prevYPlane.AsSpan()!);
            nextU.AsSpan().CopyTo(_prevUPlane.AsSpan()!);
            nextV.AsSpan().CopyTo(_prevVPlane.AsSpan()!);

            // Reconstruct _prevFrame from nextY/U/V to avoid drift (for UI preview if needed)
            YuvPlanesToRgba(nextY, nextU, nextV, _prevFrame);

            // Write end marker
            for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
            tempWriter.Write((byte)1);

            tempWriter.Flush();
            byte[] frameData = tempStream.ToArray();
            WriteChunk(QovTypes.ChunkTypePframe, (byte)(QovTypes.ChunkFlagYuv | QovTypes.ChunkFlagDctBlocks | motionFlag | refreshFlag), timestamp, frameData, false);
        }
        else
        {
            EncodeYuvPlaneTemporal(yPlane, refY, tempWriter);
            EncodeYuvPlaneTemporal(uPlane, refU, tempWriter);
            EncodeYuvPlaneTemporal(vPlane, refV, tempWriter);

            if (aPlane != null && refA != null)
            {
                EncodeYuvPlaneTemporal(aPlane, refA, tempWriter);
                aPlane.AsSpan().CopyTo(_prevAPlane.AsSpan());
            }

            // Update persistent planes
            yPlane.AsSpan().CopyTo(_prevYPlane.AsSpan()!);
            uPlane.AsSpan().CopyTo(_prevUPlane.AsSpan()!);
            vPlane.AsSpan().CopyTo(_prevVPlane.AsSpan()!);

            pixels.CopyTo(_prevFrame.AsSpan());

            // Write end marker
            for (int i = 0; i < 7; i++) tempWriter.Write((byte)0);
            tempWriter.Write((byte)1);

            tempWriter.Flush();
            byte[] frameData = tempStream.ToArray();
            WriteChunk(QovTypes.ChunkTypePframe, (byte)(QovTypes.ChunkFlagYuv | motionFlag), timestamp, frameData, false);
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


    // Intra DCT plane coding (spec 3.4.3): DC-predicted 8x8 blocks. `plane`
    // doubles as the reconstruction buffer and ends up holding the decoded
    // values, so the caller can use it directly as the P-frame reference.
    // Quantize + write the op/delta/DC/AC stream (spec 3.4.2), then reconstruct
    // the dequantized block into blockBuf (IDCT result overwrites the residuals).
    // Shared by the inter, intra-keyframe and refresh-band block coders.
    private static void WriteDctBlock(float[] blockBuf, int[] quant, byte opType, double scale, BinaryWriter writer)
    {
        float[] coeffs = new float[64];
        Dct.ForwardDct(blockBuf, coeffs);

        writer.Write(opType);
        writer.Write((byte)0x40); // qp delta 0

        int dcVal = ColorConversion.JsRound(coeffs[0] * scale / quant[0]);
        writer.Write((byte)((dcVal >> 8) & 0xff));
        writer.Write((byte)(dcVal & 0xff));

        int zeroRun = 0;
        for (int k = 1; k < 64; k++)
        {
            int zigzagIdx = Dct.ZigZag[k];
            double coeff = coeffs[zigzagIdx];
            // Dead-zone (spec 3.4.2): suppress |level| < 0.75 to kill
            // noise dithering between 0 and +/-1
            double prod = coeff * scale / quant[zigzagIdx];
            int qVal = (prod > -0.75 && prod < 0.75) ? 0 : ColorConversion.JsRound(prod);

            if (qVal == 0)
            {
                zeroRun++;
            }
            else
            {
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
                for (int sh = size - 1; sh >= 0; sh--)
                    writer.Write((byte)((qVal >> (8 * sh)) & 0xff));
                zeroRun = 0;
            }
        }
        writer.Write((byte)0x00); // EOB

        float[] recCoeffs = new float[64];
        recCoeffs[0] = (float)(dcVal * quant[0] / scale);
        for (int k = 1; k < 64; k++)
        {
            int z = Dct.ZigZag[k];
            double prod = coeffs[z] * scale / quant[z];
            int qVal = (prod > -0.75 && prod < 0.75) ? 0 : ColorConversion.JsRound(prod);
            recCoeffs[z] = (float)(qVal * quant[z] / scale);
        }
        Dct.InverseDctRaw(recCoeffs, blockBuf);
    }

    private void EncodeIntraPlaneDct(byte[] plane, int width, int height, int[] quant, byte opType, BinaryWriter writer)
    {
        int qpBase = _header.DctQpBase;
        double scale = 1.0 / (0.1 + qpBase * 0.1);
        int blocksX = (width + 7) / 8;
        int blocksY = (height + 7) / 8;
        int skipCount = 0;

        for (int by = 0; by < blocksY; by++)
        {
            for (int bx = 0; bx < blocksX; bx++)
            {
                int x0 = bx * 8;
                int y0 = by * 8;
                int pred = IntraPred(plane, width, height, x0, y0);

                float[] blockBuf = new float[64];
                int diffSum = 0;
                for (int y = 0; y < 8; y++)
                {
                    for (int x = 0; x < 8; x++)
                    {
                        int px = x0 + x;
                        int py = y0 + y;
                        if (px >= width || py >= height) { blockBuf[y * 8 + x] = 0; continue; }
                        int res = plane[py * width + px] - pred;
                        blockBuf[y * 8 + x] = res;
                        diffSum += Math.Abs(res);
                    }
                }

                if (diffSum < 32 + qpBase * 8)
                {
                    for (int y = 0; y < 8; y++)
                    {
                        if (y0 + y >= height) break;
                        for (int x = 0; x < 8; x++)
                        {
                            if (x0 + x >= width) break;
                            plane[(y0 + y) * width + x0 + x] = (byte)pred;
                        }
                    }
                    skipCount++;
                    continue;
                }

                while (skipCount > 0)
                {
                    writer.Write(QovTypes.OpDctSkip);
                    byte count = (byte)Math.Min(skipCount, 255);
                    writer.Write(count);
                    skipCount -= count;
                }

                WriteDctBlock(blockBuf, quant, opType, scale, writer);
                for (int y = 0; y < 8; y++)
                {
                    if (y0 + y >= height) break;
                    for (int x = 0; x < 8; x++)
                    {
                        if (x0 + x >= width) break;
                        int idx = (y0 + y) * width + x0 + x;
                        int val = (int)(pred + blockBuf[y * 8 + x]);
                        plane[idx] = (byte)Math.Clamp(val, 0, 255);
                    }
                }
            }
        }

        while (skipCount > 0)
        {
            writer.Write(QovTypes.OpDctSkip);
            byte count = (byte)Math.Min(skipCount, 255);
            writer.Write(count);
            skipCount -= count;
        }
    }

    // Intra DC prediction (spec 3.4.3): mean of the reconstructed left
    // column / top row; integer round-half-up; 128 with no neighbor.
    private static int IntraPred(ReadOnlySpan<byte> plane, int w, int h, int x0, int y0)
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

    private void EncodePlaneDct(ReadOnlySpan<byte> curr, ReadOnlySpan<byte> prev, Span<byte> next, int width, int height, int[] quant, byte opType, float[] blockBuf, BinaryWriter writer, int bandR0 = -1, int bandR1 = -1)
    {
        int qpBase = _header.DctQpBase;
        // TS uses double math here (1.0 / (0.1 + qp * 0.1)); float breaks bit-exactness
        double scale = 1.0 / (0.1 + qpBase * 0.1);
        int blocksX = (width + 7) / 8;
        int blocksY = (height + 7) / 8;
        int skipCount = 0;

        for (int by = 0; by < blocksY; by++)
        {
            bool inBand = by >= bandR0 && by < bandR1;
            for (int bx = 0; bx < blocksX; bx++)
            {
                int x0 = bx * 8;
                int y0 = by * 8;

                if (inBand)
                {
                    // Refresh band block (spec 3.4.4): intra semantics - the
                    // predictor comes from already-reconstructed pixels of the
                    // current frame, so fresh data never copies a damaged ref
                    int pred = IntraPred(next, width, height, x0, y0);
                    int bandDiff = 0;
                    for (int y = 0; y < 8; y++)
                    {
                        int py = y0 + y;
                        if (py >= height) continue;
                        for (int x = 0; x < 8; x++)
                        {
                            int px = x0 + x;
                            if (px >= width) continue;
                            int res = curr[py * width + px] - pred;
                            blockBuf[y * 8 + x] = res;
                            bandDiff += Math.Abs(res);
                        }
                    }

                    if (bandDiff < 32 + qpBase * 8)
                    {
                        // prediction-only block inside the band
                        for (int y = 0; y < 8; y++)
                        {
                            int py = y0 + y;
                            if (py >= height) continue;
                            for (int x = 0; x < 8; x++)
                            {
                                int px = x0 + x;
                                if (px >= width) continue;
                                next[py * width + px] = (byte)pred;
                            }
                        }
                        skipCount++;
                        continue;
                    }

                    while (skipCount > 0)
                    {
                        writer.Write(QovTypes.OpDctSkip);
                        byte count = (byte)Math.Min(skipCount, 255);
                        writer.Write(count);
                        skipCount -= count;
                    }

                    WriteDctBlock(blockBuf, quant, opType, scale, writer);
                    for (int y = 0; y < 8; y++)
                    {
                        int py = y0 + y;
                        if (py >= height) continue;
                        for (int x = 0; x < 8; x++)
                        {
                            int px = x0 + x;
                            if (px >= width) continue;
                            int idx = py * width + px;
                            int val = (int)(pred + blockBuf[y * 8 + x]);
                            next[idx] = (byte)Math.Max(0, Math.Min(255, val));
                        }
                    }
                    continue;
                }

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

                // 2. Threshold check (scales with QP so low-quality streams
                // skip more aggressively)
                if (diffSum < 32 + qpBase * 8) hasContent = false;
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

                // 3-5. DCT transform, quantize + write, reconstruct (spec 3.4.2)
                WriteDctBlock(blockBuf, quant, opType, scale, writer); 
                
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
                // Avoid INDEX 0 opcode (0x00) because it conflicts with SKIP_LONG in P-frames
                if (idx > 0 && index[idx] == val)
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
        _writer.Flush();
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
                _writer.Flush();
                _writer.BaseStream.Seek(startPos + 1, SeekOrigin.Begin);
                _writer.Write((byte)(chunkFlags | QovTypes.ChunkFlagCompressed));
                _writer.Flush();
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

        _writer.Flush();
        _writer.BaseStream.Seek(startPos + 2, SeekOrigin.Begin);
        WriteBigEndian((uint)chunkSize);
        _writer.Flush();
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
        if (_isFinished) return;
        _isFinished = true;

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

        _writer.Flush();
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

        _writer.Flush();
        _writer.BaseStream.Seek(startPos + 2, SeekOrigin.Begin);
        WriteBigEndian((uint)chunkSize);
        _writer.Flush();
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
        _writer.Flush();
        _writer.BaseStream.Seek(14, SeekOrigin.Begin);
        WriteBigEndian((uint)_frameCount);
        _writer.Flush();
    }

    public int FrameCount => _frameCount;
}