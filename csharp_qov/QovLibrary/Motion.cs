namespace QovLibrary;

/// <summary>
/// Motion estimation and compensation for QOV motion P-frames (spec v3.2 §5.2).
/// Bit-exact port of src/motion.ts.
/// </summary>
public struct MotionVectors
{
    public int BlockSize;
    public int GridW;
    public int GridH;
    public int[] Vx;   // half-pel mode: u = 2*vx + hx displacement in half-pel units
    public int[] Vy;
    public bool HalfPel;
}

public static class Motion
{
    public const int BlockSize = 16;
    public const int MaxVector = 127;

    private static int Clamp(int v, int lo, int hi)
    {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }

    /// <summary>
    /// How chroma planes sample the luma vector field: scale maps a chroma pixel
    /// to its corresponding luma pixel, shift is the per-axis mv &gt;&gt; shift derivation.
    /// </summary>
    public static (int Sx, int Sy, int Shx, int Shy) ChromaMotionParams(int colorspace)
    {
        if (colorspace == QovTypes.ColorspaceYuv420 || colorspace == QovTypes.ColorspaceYuva420)
            return (2, 2, 1, 1);
        if (colorspace == QovTypes.ColorspaceYuv422)
            return (2, 1, 1, 0);
        return (1, 1, 0, 0);
    }

    private static int SadAt(byte[] curr, byte[] prev, int w, int h,
        int bx, int by, int bw, int bh, int dx, int dy)
    {
        int sum = 0;
        for (int i = 0; i < 5; i++)
        {
            (int ox, int oy) = i switch
            {
                0 => (0, 0),
                1 => (bw - 1, 0),
                2 => (0, bh - 1),
                3 => (bw - 1, bh - 1),
                _ => (bw >> 1, bh >> 1),
            };
            int pxx = Clamp(bx + ox, 0, w - 1);
            int pyy = Clamp(by + oy, 0, h - 1);
            int sx = Clamp(bx + ox + dx, 0, w - 1);
            int sy = Clamp(by + oy + dy, 0, h - 1);
            sum += Math.Abs(curr[pyy * w + pxx] - prev[sy * w + sx]);
        }
        return sum;
    }

    private static int BlockHash(byte[] plane, int w, int bx, int by, int bw, int bh)
    {
        int key = 0;
        for (int i = 0; i < 5; i++)
        {
            (int ox, int oy) = i switch
            {
                0 => (0, 0),
                1 => (bw - 1, 0),
                2 => (0, bh - 1),
                3 => (bw - 1, bh - 1),
                _ => (bw >> 1, bh >> 1),
            };
            // unchecked 32-bit multiply+add matches TS (key * 31 + v) | 0
            key = unchecked(key * 31 + plane[(by + oy) * w + (bx + ox)]);
        }
        return key;
    }

    /// <summary>
    /// Full-block SAD at a displacement in half-pel units (u, v): the integer
    /// part floors (u >> 1) and the odd bit selects bilinear interpolation
    /// between neighbouring reference pixels. Border-clamped on all four taps.
    /// Normative refinement metric (spec v3.6 §5.2).
    /// </summary>
    private static long SadFullAt(byte[] curr, byte[] prev, int w, int h,
        int bx, int by, int bw, int bh, int u, int v)
    {
        int fx = u >> 1, fy = v >> 1;
        int hx = u & 1, hy = v & 1;
        long sum = 0;
        for (int y = 0; y < bh; y++)
        {
            int baseY = by + y + fy;
            int sy0 = Clamp(baseY, 0, h - 1);
            int sy1 = Clamp(baseY + 1, 0, h - 1);
            for (int x = 0; x < bw; x++)
            {
                int baseX = bx + x + fx;
                int sx0 = Clamp(baseX, 0, w - 1);
                int sx1 = Clamp(baseX + 1, 0, w - 1);
                int a = prev[sy0 * w + sx0];
                int s;
                if (hx == 0 && hy == 0) s = a;
                else if (hx == 0) s = (a + prev[sy1 * w + sx0] + 1) >> 1;
                else if (hy == 0) s = (a + prev[sy0 * w + sx1] + 1) >> 1;
                else s = (a + prev[sy0 * w + sx1] + prev[sy1 * w + sx0] + prev[sy1 * w + sx1] + 2) >> 2;
                int d = curr[(by + y) * w + (bx + x)] - s;
                sum += d < 0 ? -d : d;
            }
        }
        return sum;
    }

    /// <summary>
    /// Estimate 16x16 motion vectors between two single-channel planes.
    /// Returns null when too few blocks move — the caller emits a plain P-frame.
    /// </summary>
    public static MotionVectors? EstimateMotion(byte[] curr, byte[] prev, int w, int h,
        int sadSkipThreshold, bool useDiamond, int minMovedBlocks, bool halfPel)
    {
        int gridW = (w + BlockSize - 1) / BlockSize;
        int gridH = (h + BlockSize - 1) / BlockSize;
        var vx = new int[gridW * gridH];
        var vy = new int[gridW * gridH];

        // Hash every previous-frame block by its sampled content
        var table = new Dictionary<int, List<int>>();
        for (int gbY = 0; gbY < gridH; gbY++)
        {
            for (int gbX = 0; gbX < gridW; gbX++)
            {
                int bw = Math.Min(BlockSize, w - gbX * BlockSize);
                int bh = Math.Min(BlockSize, h - gbY * BlockSize);
                int key = BlockHash(prev, w, gbX * BlockSize, gbY * BlockSize, bw, bh);
                int blockId = gbY * gridW + gbX;
                if (!table.TryGetValue(key, out var list))
                {
                    list = new List<int>();
                    table[key] = list;
                }
                list.Add(blockId);
            }
        }

        int moved = 0;
        for (int gbY = 0; gbY < gridH; gbY++)
        {
            for (int gbX = 0; gbX < gridW; gbX++)
            {
                int bx = gbX * BlockSize, by = gbY * BlockSize;
                int bw = Math.Min(BlockSize, w - bx);
                int bh = Math.Min(BlockSize, h - by);

                int sad0 = SadAt(curr, prev, w, h, bx, by, bw, bh, 0, 0);
                if (sad0 <= sadSkipThreshold) continue;

                int bestVx = 0, bestVy = 0, bestSad = sad0;

                int key = BlockHash(curr, w, bx, by, bw, bh);
                if (table.TryGetValue(key, out var candidates))
                {
                    foreach (int cand in candidates)
                    {
                        int cx = cand % gridW, cy = cand / gridW;
                        int dx = cx * BlockSize - bx, dy = cy * BlockSize - by;
                        if (Math.Abs(dx) > MaxVector || Math.Abs(dy) > MaxVector) continue;
                        int s = SadAt(curr, prev, w, h, bx, by, bw, bh, dx, dy);
                        if (s < bestSad) { bestSad = s; bestVx = dx; bestVy = dy; }
                    }
                }

                if (useDiamond && bestSad > sadSkipThreshold)
                {
                    int baseX = bestVx, baseY = bestVy;
                    for (int r = 4; r >= 2; r -= 2)
                    {
                        for (int dy = -r; dy <= r; dy++)
                        {
                            for (int dx = -r; dx <= r; dx++)
                            {
                                if (Math.Abs(dx) + Math.Abs(dy) > r) continue;
                                int nvx = baseX + dx, nvy = baseY + dy;
                                if (nvx == bestVx && nvy == bestVy) continue;
                                if (Math.Abs(nvx) > MaxVector || Math.Abs(nvy) > MaxVector) continue;
                                int s = SadAt(curr, prev, w, h, bx, by, bw, bh, nvx, nvy);
                                if (s < bestSad) { bestSad = s; bestVx = nvx; bestVy = nvy; }
                            }
                        }
                    }
                }

                if (halfPel)
                {
                    // Half-pel refinement (spec v3.6 §5.2): rescore the chosen
                    // integer vector, the (0,0) prediction, and its eight
                    // half-pel neighbours with the full-block SAD; strict
                    // improvement only, center first, so ties keep the integer
                    // vector. Order of the neighbour loop is normative.
                    int cu = Clamp(bestVx * 2, -127, 127);
                    int cv = Clamp(bestVy * 2, -127, 127);
                    int bestU = cu, bestV = cv;
                    long bestFull = SadFullAt(curr, prev, w, h, bx, by, bw, bh, cu, cv);
                    long s00 = SadFullAt(curr, prev, w, h, bx, by, bw, bh, 0, 0);
                    if (s00 < bestFull) { bestFull = s00; bestU = 0; bestV = 0; }
                    for (int hv = -1; hv <= 1; hv++)
                    {
                        for (int hu = -1; hu <= 1; hu++)
                        {
                            if (hu == 0 && hv == 0) continue;
                            int nu = cu + hu, nv = cv + hv;
                            if (nu < -127 || nu > 127 || nv < -127 || nv > 127) continue;
                            long s = SadFullAt(curr, prev, w, h, bx, by, bw, bh, nu, nv);
                            if (s < bestFull) { bestFull = s; bestU = nu; bestV = nv; }
                        }
                    }
                    bestVx = bestU;
                    bestVy = bestV;
                }

                if (bestVx != 0 || bestVy != 0)
                {
                    vx[gbY * gridW + gbX] = bestVx;
                    vy[gbY * gridW + gbX] = bestVy;
                    moved++;
                }
            }
        }

        if (moved < minMovedBlocks) return null;
        return new MotionVectors { BlockSize = BlockSize, GridW = gridW, GridH = gridH, Vx = vx, Vy = vy, HalfPel = halfPel };
    }

    /// <summary>
    /// Serialize the MV block: id, count (prefix up to the last moved block), vectors.
    /// </summary>
    public static void WriteMvBlock(MotionVectors mv, BinaryWriter writer)
    {
        // id 3 = 16x16 with half-pel-unit vectors (spec v3.6 §5.2)
        byte id = mv.HalfPel ? (byte)3 : (byte)(mv.BlockSize switch { 8 => 0, 32 => 2, _ => 1 });
        writer.Write(id);
        int last = 0;
        for (int i = 0; i < mv.Vx.Length; i++)
        {
            if (mv.Vx[i] != 0 || mv.Vy[i] != 0) last = i;
        }
        int count = last + 1;
        writer.Write((byte)(count >> 8));
        writer.Write((byte)count);
        for (int i = 0; i < count; i++)
        {
            writer.Write((byte)(mv.Vx[i] & 0xff));
            writer.Write((byte)(mv.Vy[i] & 0xff));
        }
    }

    /// <summary>
    /// Parse an MV block. Extra vectors beyond the grid are consumed but
    /// discarded, keeping the stream in sync.
    /// </summary>
    public static MotionVectors ParseMvBlock(byte[] data, ref int pos, int width, int height)
    {
        byte id = data[pos++];
        bool halfPel = id == 3;
        int blockSize = id switch { 0 => 8, 2 => 32, _ => 16 };
        int count = (data[pos] << 8) | data[pos + 1];
        pos += 2;
        int gridW = (width + blockSize - 1) / blockSize;
        int gridH = (height + blockSize - 1) / blockSize;
        int total = gridW * gridH;
        var vx = new int[total];
        var vy = new int[total];
        for (int i = 0; i < count; i++)
        {
            int bx = data[pos++];
            int by = data[pos++];
            if (i < total)
            {
                vx[i] = (sbyte)bx;
                vy[i] = (sbyte)by;
            }
        }
        return new MotionVectors { BlockSize = blockSize, GridW = gridW, GridH = gridH, Vx = vx, Vy = vy, HalfPel = halfPel };
    }

    /// <summary>
    /// Bilinear half-pel sample of prev at (sx,sy)+(hx,hy); all four taps are
    /// border-clamped. Matches SadFullAt's arithmetic exactly (spec v3.6 §5.2).
    /// </summary>
    private static int HalfPelSample(byte[] prev, int w, int h, int sx, int sy, int hx, int hy)
    {
        int sx0 = Clamp(sx, 0, w - 1), sx1 = Clamp(sx + 1, 0, w - 1);
        int sy0 = Clamp(sy, 0, h - 1), sy1 = Clamp(sy + 1, 0, h - 1);
        int a = prev[sy0 * w + sx0];
        if (hx == 0 && hy == 0) return a;
        if (hx == 0) return (a + prev[sy1 * w + sx0] + 1) >> 1;
        if (hy == 0) return (a + prev[sy0 * w + sx1] + 1) >> 1;
        return (a + prev[sy0 * w + sx1] + prev[sy1 * w + sx0] + prev[sy1 * w + sx1] + 2) >> 2;
    }

    /// <summary>
    /// Build the motion-compensated copy of a single-channel plane.
    /// sampleScale maps a plane pixel to its luma pixel; shift is the
    /// per-axis mv &gt;&gt; shift chroma derivation.
    /// </summary>
    public static void CompensatePlane(byte[] prev, int w, int h, MotionVectors mv, byte[] output,
        int sampleScaleX, int sampleScaleY, int shiftX, int shiftY)
    {
        int B = mv.BlockSize;
        int gw = (w + B - 1) / B, gh = (h + B - 1) / B;
        for (int gbY = 0; gbY < gh; gbY++)
        {
            for (int gbX = 0; gbX < gw; gbX++)
            {
                int lumX = Math.Min(mv.GridW - 1, gbX * B * sampleScaleX / mv.BlockSize);
                int lumY = Math.Min(mv.GridH - 1, gbY * B * sampleScaleY / mv.BlockSize);
                int li = lumY * mv.GridW + lumX;
                int u = mv.Vx[li], v = mv.Vy[li];
                bool luma = shiftX == 0 && shiftY == 0;
                int hx = luma && mv.HalfPel ? (u & 1) : 0;
                int hy = luma && mv.HalfPel ? (v & 1) : 0;
                int vx = mv.HalfPel ? (u >> (shiftX + 1)) : (u >> shiftX);
                int vy = mv.HalfPel ? (v >> (shiftY + 1)) : (v >> shiftY);
                int bw = Math.Min(B, w - gbX * B), bh = Math.Min(B, h - gbY * B);
                bool half = hx != 0 || hy != 0;
                for (int y = 0; y < bh; y++)
                {
                    int oRow = (gbY * B + y) * w + gbX * B;
                    if (!half)
                    {
                        int sy = Clamp(gbY * B + y + vy, 0, h - 1);
                        int sRow = sy * w;
                        for (int x = 0; x < bw; x++)
                        {
                            int sx = Clamp(gbX * B + x + vx, 0, w - 1);
                            output[oRow + x] = prev[sRow + sx];
                        }
                    }
                    else
                    {
                        for (int x = 0; x < bw; x++)
                        {
                            output[oRow + x] = (byte)HalfPelSample(prev, w, h, gbX * B + x + vx, gbY * B + y + vy, hx, hy);
                        }
                    }
                }
            }
        }
    }

    /// <summary>
    /// Motion-compensated copy of an RGBA frame (stride 4, luma vectors unshifted).
    /// </summary>
    public static void CompensateFrame(byte[] prev, int w, int h, MotionVectors mv, byte[] output)
    {
        int B = mv.BlockSize;
        int gw = (w + B - 1) / B, gh = (h + B - 1) / B;
        for (int gbY = 0; gbY < gh; gbY++)
        {
            for (int gbX = 0; gbX < gw; gbX++)
            {
                int li = gbY * mv.GridW + gbX;
                int u = mv.Vx[li], v = mv.Vy[li];
                int hx = mv.HalfPel ? (u & 1) : 0, hy = mv.HalfPel ? (v & 1) : 0;
                int vx = mv.HalfPel ? (u >> 1) : u;
                int vy = mv.HalfPel ? (v >> 1) : v;
                int bw = Math.Min(B, w - gbX * B), bh = Math.Min(B, h - gbY * B);
                bool half = hx != 0 || hy != 0;
                for (int y = 0; y < bh; y++)
                {
                    int oRow = ((gbY * B + y) * w + gbX * B) * 4;
                    for (int x = 0; x < bw; x++)
                    {
                        int o = oRow + x * 4;
                        if (!half)
                        {
                            int sy = Clamp(gbY * B + y + vy, 0, h - 1);
                            int sx = Clamp(gbX * B + x + vx, 0, w - 1);
                            int s = (sy * w) * 4 + sx * 4;
                            output[o] = prev[s];
                            output[o + 1] = prev[s + 1];
                            output[o + 2] = prev[s + 2];
                            output[o + 3] = prev[s + 3];
                        }
                        else
                        {
                            for (int ch = 0; ch < 4; ch++)
                            {
                                int sx0 = Clamp(gbX * B + x + vx, 0, w - 1), sx1 = Clamp(gbX * B + x + vx + 1, 0, w - 1);
                                int sy0 = Clamp(gbY * B + y + vy, 0, h - 1), sy1 = Clamp(gbY * B + y + vy + 1, 0, h - 1);
                                int a = prev[(sy0 * w + sx0) * 4 + ch];
                                int s2;
                                if (hx == 0) s2 = (a + prev[(sy1 * w + sx0) * 4 + ch] + 1) >> 1;
                                else if (hy == 0) s2 = (a + prev[(sy0 * w + sx1) * 4 + ch] + 1) >> 1;
                                else s2 = (a + prev[(sy0 * w + sx1) * 4 + ch] + prev[(sy1 * w + sx0) * 4 + ch] + prev[(sy1 * w + sx1) * 4 + ch] + 2) >> 2;
                                output[o + ch] = (byte)s2;
                            }
                        }
                    }
                }
            }
        }
    }
}
