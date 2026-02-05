using System;

namespace QovLibrary;

public static class Dct
{
    private const int Size = 8;
    private const double PI = Math.PI;
    private static readonly double[][] CosTable;
    private static readonly double C0 = 1.0 / Math.Sqrt(2.0);

    // Standard ZigZag order
    public static readonly int[] ZigZag =
    {
        0,  1,  5,  6, 14, 15, 27, 28,
        2,  4,  7, 13, 16, 26, 29, 42,
        3,  8, 12, 17, 25, 30, 41, 43,
        9, 11, 18, 24, 31, 40, 44, 53,
       10, 19, 23, 32, 39, 45, 52, 54,
       20, 22, 33, 38, 46, 51, 55, 60,
       21, 34, 37, 47, 50, 56, 59, 61,
       35, 36, 48, 49, 57, 58, 62, 63
    };

    public static readonly int[] DefaultQuantLuma =
    {
        16, 11, 10, 16, 24, 40, 51, 61,
        12, 12, 14, 19, 26, 58, 60, 55,
        14, 13, 16, 24, 40, 57, 69, 56,
        14, 17, 22, 29, 51, 87, 80, 62,
        18, 22, 37, 56, 68,109,103, 77,
        24, 35, 55, 64, 81,104,113, 92,
        49, 64, 78, 87,103,121,120,101,
        72, 92, 95, 98,112,100,103, 99
    };

    public static readonly int[] DefaultQuantChroma =
    {
        17, 18, 24, 47, 99, 99, 99, 99,
        18, 21, 26, 66, 99, 99, 99, 99,
        24, 26, 56, 99, 99, 99, 99, 99,
        47, 66, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99
    };

    static Dct()
    {
        CosTable = new double[8][];
        for (int i = 0; i < 8; i++)
        {
            CosTable[i] = new double[8];
            for (int j = 0; j < 8; j++)
            {
                CosTable[i][j] = Math.Cos(((2 * i + 1) * j * PI) / 16.0);
            }
        }
    }

    public static void ForwardDct(float[] block, float[] coeffs)
    {
        for (int v = 0; v < 8; v++)
        {
            double Cv = (v == 0) ? C0 : 1.0;
            for (int u = 0; u < 8; u++)
            {
                double Cu = (u == 0) ? C0 : 1.0;
                double sum = 0.0;

                for (int y = 0; y < 8; y++)
                {
                    for (int x = 0; x < 8; x++)
                    {
                        sum += block[y * 8 + x] * CosTable[x][u] * CosTable[y][v];
                    }
                }

                coeffs[v * 8 + u] = (float)(0.25 * Cu * Cv * sum);
            }
        }
    }

    public static void InverseDct(float[] coeffs, byte[] output)
    {
        for (int y = 0; y < 8; y++)
        {
            for (int x = 0; x < 8; x++)
            {
                double sum = 0.0;

                for (int v = 0; v < 8; v++)
                {
                    double Cv = (v == 0) ? C0 : 1.0;
                    for (int u = 0; u < 8; u++)
                    {
                        double Cu = (u == 0) ? C0 : 1.0;
                        sum += Cu * Cv * coeffs[v * 8 + u] * CosTable[x][u] * CosTable[y][v];
                    }
                }

                int val = (int)Math.Round((0.25 * sum) + 128.0);
                output[y * 8 + x] = (byte)Math.Clamp(val, 0, 255);
            }
        }
    }

    public static void InverseDctRaw(float[] coeffs, float[] output)
    {
        for (int y = 0; y < 8; y++)
        {
            for (int x = 0; x < 8; x++)
            {
                double sum = 0.0;

                for (int v = 0; v < 8; v++)
                {
                    double Cv = (v == 0) ? C0 : 1.0;
                    for (int u = 0; u < 8; u++)
                    {
                        double Cu = (u == 0) ? C0 : 1.0;
                        sum += Cu * Cv * coeffs[v * 8 + u] * CosTable[x][u] * CosTable[y][v];
                    }
                }

                output[y * 8 + x] = (float)(0.25 * sum);
            }
        }
    }
}
