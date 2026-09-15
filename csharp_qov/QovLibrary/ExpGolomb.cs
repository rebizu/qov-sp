using System;
using System.Collections.Generic;

namespace QovLibrary
{
    // Exp-Golomb bit I/O (spec 3.4.5).
    // ue(v): v+1 in binary prefixed with bitlength(v+1)-1 zeros;
    // se(v): v>0 -> ue(2v-1), else ue(-2v).
    // MSB-first, zero-padded to a byte boundary at the end of each DCT
    // block's coefficient section so opcode framing stays byte-aligned.
    // Must stay bit-exact with qov.h and the TS implementation.
    public sealed class EgBitWriter
    {
        private readonly List<byte> _bytes = new List<byte>();
        private uint _acc;
        private int _nbits;

        private void Bit(int b)
        {
            _acc = (_acc << 1) | (uint)(b & 1);
            if (++_nbits == 8)
            {
                _bytes.Add((byte)(_acc & 0xff));
                _acc = 0;
                _nbits = 0;
            }
        }

        public void Put(uint v, int n)
        {
            for (int i = n - 1; i >= 0; i--) Bit((int)((v >> i) & 1));
        }

        public void Ue(uint v)
        {
            uint x = v + 1;
            int n = 0;
            while ((x >> (n + 1)) != 0) n++;
            for (int i = 0; i < n; i++) Bit(0);
            Put(x, n + 1);
        }

        public void Se(int v)
        {
            Ue(v <= 0 ? (uint)(-2 * v) : (uint)(2 * v - 1));
        }

        public byte[] Flush()
        {
            while (_nbits != 0) Bit(0);
            return _bytes.ToArray();
        }
    }

    public sealed class EgBitReader
    {
        private readonly Func<int> _readU8;
        private uint _acc;
        private int _nbits;

        public EgBitReader(Func<int> readU8)
        {
            _readU8 = readU8;
        }

        private int Bit()
        {
            if (_nbits == 0)
            {
                _acc = (uint)_readU8();
                _nbits = 8;
            }
            _nbits--;
            return (int)((_acc >> _nbits) & 1);
        }

        public uint Ue()
        {
            int zeros = 0;
            while (Bit() == 0)
            {
                if (++zeros > 31) return 0xffffffffu;
            }
            uint v = 1;
            for (int i = 0; i < zeros; i++) v = (v << 1) | (uint)Bit();
            return v - 1;
        }

        public int Se()
        {
            uint u = Ue();
            return (u & 1) != 0 ? (int)((u >> 1) + 1) : -(int)(u >> 1);
        }
    }
}
