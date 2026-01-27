namespace QovLibrary;

/// <summary>
/// Color conversion utilities using BT.601 coefficients.
/// </summary>
public static class ColorConversion
{
    private const double Kr = 0.299;
    private const double Kg = 0.587;
    private const double Kb = 0.114;

    public static void RgbaToYuv420(ReadOnlySpan<byte> pixels, int width, int height,
        out byte[] yPlane, out byte[] uPlane, out byte[] vPlane)
    {
        int pixelCount = width * height;
        yPlane = new byte[pixelCount];
        int uvWidth = (width + 1) / 2;
        int uvHeight = (height + 1) / 2;
        int uvSize = uvWidth * uvHeight;
        uPlane = new byte[uvSize];
        vPlane = new byte[uvSize];

        for (int py = 0; py < height; py++)
        {
            for (int px = 0; px < width; px++)
            {
                int idx = (py * width + px) * 4;
                byte r = pixels[idx];
                byte g = pixels[idx + 1];
                byte b = pixels[idx + 2];

                int y = (int)(Kr * r + Kg * g + Kb * b);
                yPlane[py * width + px] = (byte)Clamp(y, 0, 255);
            }
        }

        for (int py = 0; py < uvHeight; py++)
        {
            for (int px = 0; px < uvWidth; px++)
            {
                int uSum = 0, vSum = 0, count = 0;

                for (int dy = 0; dy < 2; dy++)
                {
                    for (int dx = 0; dx < 2; dx++)
                    {
                        int srcX = px * 2 + dx;
                        int srcY = py * 2 + dy;

                        if (srcX < width && srcY < height)
                        {
                            int idx = (srcY * width + srcX) * 4;
                            byte r = pixels[idx];
                            byte g = pixels[idx + 1];
                            byte b = pixels[idx + 2];

                            uSum += (int)(-0.147 * r - 0.289 * g + 0.436 * b + 128);
                            vSum += (int)(0.615 * r - 0.515 * g - 0.100 * b + 128);
                            count++;
                        }
                    }
                }

                int uvIdx = py * uvWidth + px;
                uPlane[uvIdx] = (byte)Clamp(uSum / count, 0, 255);
                vPlane[uvIdx] = (byte)Clamp(vSum / count, 0, 255);
            }
        }
    }

    public static void Yuv420ToRgba(ReadOnlySpan<byte> yPlane, ReadOnlySpan<byte> uPlane,
        ReadOnlySpan<byte> vPlane, int width, int height, Span<byte> output)
    {
        int uvWidth = (width + 1) / 2;

        for (int py = 0; py < height; py++)
        {
            for (int px = 0; px < width; px++)
            {
                int yIdx = py * width + px;
                int uvIdx = (py / 2) * uvWidth + (px / 2);

                byte y = yPlane[yIdx];
                byte u = uPlane[uvIdx];
                byte v = vPlane[uvIdx];

                int r = (int)(y + 1.140 * (v - 128));
                int g = (int)(y - 0.395 * (u - 128) - 0.581 * (v - 128));
                int b = (int)(y + 2.032 * (u - 128));

                int outIdx = yIdx * 4;
                output[outIdx] = (byte)Clamp(r, 0, 255);
                output[outIdx + 1] = (byte)Clamp(g, 0, 255);
                output[outIdx + 2] = (byte)Clamp(b, 0, 255);
                output[outIdx + 3] = 255;
            }
        }
    }

    public static void Yuv420ToRgbaWithAlpha(ReadOnlySpan<byte> yPlane, ReadOnlySpan<byte> uPlane,
        ReadOnlySpan<byte> vPlane, ReadOnlySpan<byte> aPlane, int width, int height, Span<byte> output)
    {
        int uvWidth = (width + 1) / 2;

        for (int py = 0; py < height; py++)
        {
            for (int px = 0; px < width; px++)
            {
                int yIdx = py * width + px;
                int uvIdx = (py / 2) * uvWidth + (px / 2);

                byte y = yPlane[yIdx];
                byte u = uPlane[uvIdx];
                byte v = vPlane[uvIdx];
                byte a = aPlane[yIdx];

                int r = (int)(y + 1.140 * (v - 128));
                int g = (int)(y - 0.395 * (u - 128) - 0.581 * (v - 128));
                int b = (int)(y + 2.032 * (u - 128));

                int outIdx = yIdx * 4;
                output[outIdx] = (byte)Clamp(r, 0, 255);
                output[outIdx + 1] = (byte)Clamp(g, 0, 255);
                output[outIdx + 2] = (byte)Clamp(b, 0, 255);
                output[outIdx + 3] = a;
            }
        }
    }

    private static int Clamp(int value, int min, int max)
    {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }
}