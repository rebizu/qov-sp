using QovLibrary;
using System.Text.Json;

// QOV corpus generator CLI (C# implementation).
//
// Usage: QovEncoder <case.json> <out.qov>
//
// The case JSON is the same format used by qov-analysis-tools/tscli.ts; the
// four patterns and the 31-bit LCG MUST stay bit-identical to the TypeScript
// implementation (see qov-analysis-tools/README.md). Motion-vector cases are
// rejected: the C# encoder does not implement motion estimation.

class Program
{
    const int FlagHasAlpha = 0x01;
    const int FlagHasMotion = 0x02;
    const int FlagHasIndex = 0x04;

    static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.WriteLine("Usage: QovEncoder <case.json> <out.qov>");
            return 1;
        }

        var json = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
        string id = json.GetProperty("id").GetString()!;
        int width = json.GetProperty("width").GetInt32();
        int height = json.GetProperty("height").GetInt32();
        int frames = json.GetProperty("frames").GetInt32();
        int fps = json.GetProperty("fps").GetInt32();
        string colorspace = json.GetProperty("colorspace").GetString()!;
        string pattern = json.GetProperty("pattern").GetString()!;
        int keyframeInterval = json.TryGetProperty("keyframeInterval", out var ki) ? ki.GetInt32() : 2;
        bool compression = !json.TryGetProperty("compression", out var comp) || comp.GetBoolean();
        int quality = json.TryGetProperty("quality", out var q) ? q.GetInt32() : 0;
        bool hasAlpha = false, hasMotion = false, hasIndex = true;
        if (json.TryGetProperty("flags", out var fl))
        {
            foreach (var f in fl.EnumerateArray())
            {
                switch (f.GetString())
                {
                    case "alpha": hasAlpha = true; break;
                    case "motion": hasMotion = true; break;
                    case "index": hasIndex = true; break;
                }
            }
        }
        if (json.TryGetProperty("audio", out var audioEl) && audioEl.ValueKind != JsonValueKind.Null)
        {
            Console.WriteLine("C# corpus generator does not support audio cases");
            return 1;
        }

        int cs = colorspace switch
        {
            "srgb" => QovTypes.ColorspaceSrgb,
            "srgba" => QovTypes.ColorspaceSrgba,
            "linear" => QovTypes.ColorspaceLinear,
            "linear_a" => QovTypes.ColorspaceLinearA,
            "yuv420" => QovTypes.ColorspaceYuv420,
            "yuv422" => QovTypes.ColorspaceYuv422,
            "yuv444" => QovTypes.ColorspaceYuv444,
            "yuva420" => QovTypes.ColorspaceYuva420,
            _ => throw new ArgumentException($"unknown colorspace {colorspace}"),
        };
        if (hasAlpha && cs is not (QovTypes.ColorspaceSrgba or QovTypes.ColorspaceLinearA or QovTypes.ColorspaceYuva420))
        {
            Console.WriteLine("alpha flag requires an alpha colorspace");
            return 1;
        }

        int flags = FlagHasIndex | (hasAlpha ? FlagHasAlpha : 0) | (hasMotion ? FlagHasMotion : 0);

        using var stream = File.Create(args[1]);
        var encoder = new QovEncoder(stream, (ushort)width, (ushort)height,
            (ushort)fps, 1, (byte)flags, (byte)cs, compression, quality);

        for (int n = 0; n < frames; n++)
        {
            var pixels = MakeFrame(pattern, width, height, n, hasAlpha);
            uint timestamp = (uint)Math.Floor(n * 1000000.0 / fps + 0.5);
            if (n % keyframeInterval == 0)
                encoder.EncodeKeyframe(pixels, timestamp);
            else
                encoder.EncodePFrame(pixels, timestamp);
        }
        encoder.Finish();

        Console.WriteLine($"Encoded {frames} frames to {args[1]}");
        return 0;
    }

    static readonly byte[][] Palette =
    {
        new byte[] { 255, 0, 0 }, new byte[] { 0, 255, 0 }, new byte[] { 0, 0, 255 },
        new byte[] { 255, 255, 0 }, new byte[] { 0, 255, 255 }, new byte[] { 255, 0, 255 },
        new byte[] { 255, 255, 255 }, new byte[] { 128, 128, 128 },
    };

    // Deterministic 31-bit LCG, bit-identical to tscli.ts (Math.imul semantics)
    static int LcgNext(int s)
        => unchecked(s * 1103515245 + 12345) & 0x7fffffff;

    static byte LcgByte(ref int s)
    {
        s = LcgNext(s);
        return (byte)((((uint)s) >> 16) & 0xff);
    }

    // JS Math.round semantics (half away from -inf boundary; inputs are >= 0 here)
    static int RoundHalfUp(double v) => (int)Math.Floor(v + 0.5);

    static byte[] MakeFrame(string pattern, int w, int h, int n, bool hasAlphaCh)
    {
        var px = new byte[w * h * 4];
        int s = 12345 + n * 7919;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 4;
                int r = 0, g = 0, b = 0;
                switch (pattern)
                {
                    case "gradient":
                        r = RoundHalfUp(x * 255.0 / Math.Max(1, w - 1));
                        g = RoundHalfUp(y * 255.0 / Math.Max(1, h - 1));
                        b = (x + y + n * 4) & 0xff;
                        break;
                    case "stripes":
                        var p = Palette[(x / 16 + n) % Palette.Length];
                        r = p[0]; g = p[1]; b = p[2];
                        break;
                    case "scroll16":
                        int u = (x + n * 16) % w;
                        r = (u * 3 + y) & 0xff;
                        g = (u + y * 2) & 0xff;
                        b = (u * u + y) & 0xff;
                        break;
                    case "noise":
                        r = LcgByte(ref s);
                        g = LcgByte(ref s);
                        b = LcgByte(ref s);
                        break;
                    case "checker":
                        int v = (x + y + n) % 2 == 0 ? 255 : 0;
                        r = v; g = v; b = v;
                        break;
                    default:
                        throw new ArgumentException($"unknown pattern {pattern}");
                }
                px[i] = (byte)r;
                px[i + 1] = (byte)g;
                px[i + 2] = (byte)b;
                px[i + 3] = hasAlphaCh ? (byte)((x + n * 8) & 0xff) : (byte)255;
            }
        }
        return px;
    }
}
