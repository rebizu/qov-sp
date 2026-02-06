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

        // First pass: compute Y for all pixels
        for (int py = 0; py < height; py++)
        {
            for (int px = 0; px < width; px++)
            {
                int idx = (py * width + px) * 4;
                byte r = pixels[idx];
                byte g = pixels[idx + 1];
                byte b = pixels[idx + 2];

                // Y = 0.299*R + 0.587*G + 0.114*B
                double y = 0.299 * r + 0.587 * g + 0.114 * b;
                yPlane[py * width + px] = (byte)Clamp((int)Math.Round(y), 0, 255);
            }
        }

        // Second pass: compute U and V with 2x2 subsampling (luminance-weighted average)
        for (int py = 0; py < uvHeight; py++)
        {
            for (int px = 0; px < uvWidth; px++)
            {
                double uSum = 0, vSum = 0, weightSum = 0;

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

                            double yVal = yPlane[srcY * width + srcX];
                            double u = -0.169 * r - 0.331 * g + 0.500 * b + 128;
                            double v = 0.500 * r - 0.419 * g - 0.081 * b + 128;

                            // Weight by luminance: darker pixels contribute less to chroma
                            // Use (Y + 16) to avoid zero weight and give some influence to dark pixels
                            double weight = yVal + 16;

                            uSum += u * weight;
                            vSum += v * weight;
                            weightSum += weight;
                        }
                    }
                }

                int uvIdx = py * uvWidth + px;
                if (weightSum > 0)
                {
                    uPlane[uvIdx] = (byte)Clamp((int)Math.Round(uSum / weightSum), 0, 255);
                    vPlane[uvIdx] = (byte)Clamp((int)Math.Round(vSum / weightSum), 0, 255);
                }
                else
                {
                    uPlane[uvIdx] = 128;
                    vPlane[uvIdx] = 128;
                }
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

                // R = Y + 1.402*(V-128)
                // G = Y - 0.344*(U-128) - 0.714*(V-128)
                // B = Y + 1.772*(U-128)
                int r = (int)Math.Round(y + 1.402 * (v - 128));
                int g = (int)Math.Round(y - 0.344 * (u - 128) - 0.714 * (v - 128));
                int b = (int)Math.Round(y + 1.772 * (u - 128));

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

                int r = (int)Math.Round(y + 1.402 * (v - 128));
                int g = (int)Math.Round(y - 0.344 * (u - 128) - 0.714 * (v - 128));
                int b = (int)Math.Round(y + 1.772 * (u - 128));

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