// Order-0 adaptive range coder (spec v3.8 section 2.2, chunk flag 0x08).
// Byte-oriented adaptive model: 256 frequencies starting at 1, +32 per
// symbol, halved when the total passes 65536. LZMA-style 32-bit range with
// carry cache. Integer math only — must mirror qov.h / range-coder.ts
// bit-exactly.
namespace QovLibrary;

public class QovRangeCoder
{
    private const uint Top = 1u << 24;
    private const uint Step = 32;
    private const uint Limit = 1u << 16;

    private sealed class Model
    {
        public uint[] Freq = new uint[256];
        public uint[] Cum = new uint[257];
        public uint Total;

        public Model()
        {
            Array.Fill(Freq, 1u);
            for (int i = 0; i <= 256; i++) Cum[i] = (uint)i;
            Total = 256;
        }

        public void Update(int s)
        {
            Freq[s] += Step;
            Total += Step;
            if (Total > Limit)
            {
                Total = 0;
                for (int i = 0; i < 256; i++)
                {
                    Freq[i] = (Freq[i] + 1) >> 1;
                    Total += Freq[i];
                }
            }
            Cum[0] = 0;
            for (int i = 0; i < 256; i++) Cum[i + 1] = Cum[i] + Freq[i];
        }
    }

    public static byte[] Encode(ReadOnlySpan<byte> input)
    {
        var model = new Model();
        var outStream = new MemoryStream();
        ulong low = 0;
        uint range = 0xFFFFFFFFu;
        byte cache = 0;
        long cacheSize = 1;

        void ShiftLow()
        {
            if ((uint)low < 0xFF000000u || (low >> 32) != 0)
            {
                byte carry = (byte)(low >> 32);
                byte temp = cache;
                do
                {
                    outStream.WriteByte((byte)(temp + carry));
                    temp = 0xFF;
                } while (--cacheSize != 0);
                cache = (byte)(low >> 24);
            }
            cacheSize++;
            low = (uint)low << 8;
        }

        foreach (byte b in input)
        {
            range /= model.Total;
            low += (ulong)model.Cum[b] * range;
            range *= model.Freq[b];
            while (range < Top) { ShiftLow(); range <<= 8; }
            model.Update(b);
        }
        for (int i = 0; i < 5; i++) ShiftLow();
        return outStream.ToArray();
    }

    public static byte[] Decode(ReadOnlySpan<byte> inputSpan, int rawLen)
    {
        byte[] input = inputSpan.ToArray(); // span can't be captured by the local Next()
        var model = new Model();
        var output = new byte[rawLen];
        int pos = 0;

        uint Next()
        {
            byte b = pos < input.Length ? input[pos++] : (byte)0;
            return b;
        }

        uint range = 0xFFFFFFFFu;
        Next(); // first encoder byte is the initial cache
        uint code = 0;
        for (int i = 0; i < 4; i++) code = (code << 8) | Next();

        for (int i = 0; i < rawLen; i++)
        {
            range /= model.Total;
            uint v = code / range;
            if (v >= model.Total) v = model.Total - 1;
            int s = 0;
            while (model.Cum[s + 1] <= v) s++;
            code -= model.Cum[s] * range;
            range *= model.Freq[s];
            while (range < Top) { code = (code << 8) | Next(); range <<= 8; }
            model.Update(s);
            output[i] = (byte)s;
        }
        return output;
    }
}
