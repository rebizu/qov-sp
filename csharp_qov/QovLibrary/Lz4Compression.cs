namespace QovLibrary;

/// <summary>
/// LZ4 block compression/decompression for QOV.
/// Based on LZ4 block format specification.
/// </summary>
public static class Lz4Compression
{
    private const int HashSize = 1 << 16;
    private const int HashPrime = unchecked((int)2654435769);
    private const int MinMatch = 4;
    private const int LastLiterals = 5;
    private const int MaxDistance = 65535;

    /// <summary>
    /// Compress a block of data using LZ4 block format.
    /// Returns compressed data or null if compression would not reduce size.
    /// </summary>
    public static byte[]? Compress(ReadOnlySpan<byte> input)
    {
        int inputSize = input.Length;
        if (inputSize == 0)
            return Array.Empty<byte>();

        int maxOutputSize = inputSize + (inputSize / 255) + 16;
        byte[] output = new byte[maxOutputSize];
        int outPos = 0;

        int[] hashTable = new int[HashSize];
        Array.Fill(hashTable, -1);

        int anchor = 0;
        int pos = 0;

        while (pos < inputSize - LastLiterals)
        {
            int h = Hash4(input, pos);
            int refPos = hashTable[h];
            hashTable[h] = pos;

            if (refPos >= 0 && pos - refPos < MaxDistance && Match4(input, pos, refPos))
            {
                int literalLen = pos - anchor;

                int matchLen = MinMatch;
                while (pos + matchLen < inputSize - LastLiterals && input[refPos + matchLen] == input[pos + matchLen])
                    matchLen++;

                int tokenPos = outPos++;
                byte token = 0;

                if (literalLen >= 15)
                {
                    token = (byte)(15 << 4);
                    int remaining = literalLen - 15;
                    while (remaining >= 255)
                    {
                        output[outPos++] = 255;
                        remaining -= 255;
                    }
                    output[outPos++] = (byte)remaining;
                }
                else
                {
                    token = (byte)(literalLen << 4);
                }

                for (int i = 0; i < literalLen; i++)
                    output[outPos++] = input[anchor + i];

                int offset = pos - refPos;
                output[outPos++] = (byte)(offset & 0xFF);
                output[outPos++] = (byte)((offset >> 8) & 0xFF);

                int matchLenMinus4 = matchLen - MinMatch;
                if (matchLenMinus4 >= 15)
                {
                    token |= 15;
                    int remaining = matchLenMinus4 - 15;
                    while (remaining >= 255)
                    {
                        output[outPos++] = 255;
                        remaining -= 255;
                    }
                    output[outPos++] = (byte)remaining;
                }
                else
                {
                    token |= (byte)matchLenMinus4;
                }

                output[tokenPos] = token;

                pos += matchLen;
                anchor = pos;

                if (pos < inputSize - LastLiterals)
                {
                    hashTable[Hash4(input, pos - 2)] = pos - 2;
                }
            }
            else
            {
                pos++;
            }
        }

        int lastLiterals = inputSize - anchor;
        if (lastLiterals > 0)
        {
            if (lastLiterals >= 15)
            {
                output[outPos++] = (byte)(15 << 4);
                int remaining = lastLiterals - 15;
                while (remaining >= 255)
                {
                    output[outPos++] = 255;
                    remaining -= 255;
                }
                output[outPos++] = (byte)remaining;
            }
            else
            {
                output[outPos++] = (byte)(lastLiterals << 4);
            }

            for (int i = 0; i < lastLiterals; i++)
                output[outPos++] = input[anchor + i];
        }

        if (outPos >= inputSize * 0.95)
            return null;

        return output.AsSpan(0, outPos).ToArray();
    }

    /// <summary>
    /// Decompress LZ4 block format data.
    /// </summary>
    public static byte[] Decompress(ReadOnlySpan<byte> input, int outputSize)
    {
        if (input.Length == 0)
            return Array.Empty<byte>();

        byte[] output = new byte[outputSize];
        int inPos = 0;
        int outPos = 0;

        while (inPos < input.Length)
        {
            byte token = input[inPos++];
            int literalLen = token >> 4;
            int matchLen = token & 0x0F;

            int litLen = literalLen;
            if (literalLen == 15)
            {
                byte b;
                do
                {
                    b = input[inPos++];
                    litLen += b;
                } while (b == 255);
            }

            for (int i = 0; i < litLen; i++)
                output[outPos++] = input[inPos++];

            if (inPos >= input.Length)
                break;

            int offset = input[inPos++] | (input[inPos++] << 8);

            int mLen = matchLen + 4;
            if (matchLen == 15)
            {
                byte b;
                do
                {
                    b = input[inPos++];
                    mLen += b;
                } while (b == 255);
            }

            int matchPos = outPos - offset;
            for (int i = 0; i < mLen; i++)
                output[outPos++] = output[matchPos + i];
        }

        return output;
    }

    private static int Hash4(ReadOnlySpan<byte> data, int pos)
    {
        int v = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
        return (v * HashPrime >>> 16) & 0xFFFF;
    }

    private static bool Match4(ReadOnlySpan<byte> data, int pos1, int pos2)
    {
        return data[pos1] == data[pos2] &&
               data[pos1 + 1] == data[pos2 + 1] &&
               data[pos1 + 2] == data[pos2 + 2] &&
               data[pos1 + 3] == data[pos2 + 3];
    }
}