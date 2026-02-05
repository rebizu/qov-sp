using System;

namespace QovLibrary;

// QOA - Quite OK Audio Implementation
public static class Qoa
{
    public const int MinFileSize = 16;
    public const int MaxChannels = 8;
    public const int SliceLen = 20;
    public const int SlicesPerFrame = 256;
    public const int FrameLen = SlicesPerFrame * SliceLen;
    public const int HeaderSize = 8;
    public const int Magic = 0x716f6166; // 'qoaf'

    // Dequantization table
    public static readonly int[][] DequantTab =
    {
        new[] {1, -1, 3, -3, 5, -5, 7, -7},
        new[] {5, -5, 18, -18, 32, -32, 49, -49},
        new[] {16, -16, 53, -53, 95, -95, 147, -147},
        new[] {34, -34, 113, -113, 203, -203, 315, -315},
        new[] {63, -63, 210, -210, 378, -378, 588, -588},
        new[] {104, -104, 345, -345, 621, -621, 966, -966},
        new[] {158, -158, 528, -528, 950, -950, 1477, -1477},
        new[] {228, -228, 760, -760, 1368, -1368, 2128, -2128},
        new[] {316, -316, 1053, -1053, 1895, -1895, 2947, -2947},
        new[] {422, -422, 1405, -1405, 2529, -2529, 3934, -3934},
        new[] {548, -548, 1828, -1828, 3290, -3290, 5117, -5117},
        new[] {696, -696, 2320, -2320, 4176, -4176, 6496, -6496},
        new[] {866, -866, 2885, -2885, 5193, -5193, 8077, -8077},
        new[] {1058, -1058, 3528, -3528, 6349, -6349, 9877, -9877},
        new[] {1274, -1274, 4248, -4248, 7646, -7646, 11894, -11894},
        new[] {1514, -1514, 5045, -5045, 9081, -9081, 14126, -14126}
    };
}

public class QoaLms
{
    public int[] History { get; } = new int[4];
    public int[] Weights { get; } = new int[4];
    
    // QOA spec: history init 0. weights {0, 0, -1<<13, 1<<14}
    public QoaLms()
    {
       Weights[0] = 0;
       Weights[1] = 0;
       Weights[2] = -(1 << 13);
       Weights[3] =  (1 << 14);
    }
    
    public void Reset()
    {
        Array.Clear(History);
        Weights[0] = 0;
        Weights[1] = 0;
        Weights[2] = -(1 << 13);
        Weights[3] =  (1 << 14);
    }
    
    public QoaLms Clone()
    {
        var clone = new QoaLms();
        Array.Copy(History, clone.History, 4);
        Array.Copy(Weights, clone.Weights, 4);
        return clone;
    }
}

public class QoaEncoder
{
    private readonly int _channels;
    private readonly int _sampleRate;
    private readonly QoaLms[] _lms;
    
    public QoaEncoder(int channels, int sampleRate)
    {
        _channels = channels;
        _sampleRate = sampleRate;
        _lms = new QoaLms[channels];
        for(int c=0; c<channels; c++) _lms[c] = new QoaLms();
    }
    
    public byte[] EncodeFrame(ReadOnlySpan<float> samples)
    {
        int totalSamples = samples.Length / _channels;
        int frameSize = Qoa.HeaderSize + (_channels * 16) + ((totalSamples + Qoa.SliceLen - 1) / Qoa.SliceLen * 8 * _channels);
        
        byte[] buffer = new byte[frameSize];
        int p = 0;
        
        // Header
        buffer[p++] = (byte)_channels;
        buffer[p++] = (byte)((_sampleRate >> 16) & 0xff);
        buffer[p++] = (byte)((_sampleRate >> 8) & 0xff);
        buffer[p++] = (byte)(_sampleRate & 0xff);
        buffer[p++] = (byte)((totalSamples >> 8) & 0xff);
        buffer[p++] = (byte)(totalSamples & 0xff);
        buffer[p++] = (byte)((frameSize >> 8) & 0xff);
        buffer[p++] = (byte)(frameSize & 0xff);
        
        // LMS State
        for (int c = 0; c < _channels; c++)
        {
            var lms = _lms[c];
            for (int i = 0; i < 4; i++)
            {
                int h = lms.History[i];
                buffer[p++] = (byte)((h >> 8) & 0xff);
                buffer[p++] = (byte)(h & 0xff);
            }
            for (int i = 0; i < 4; i++)
            {
                int w = lms.Weights[i];
                buffer[p++] = (byte)((w >> 8) & 0xff);
                buffer[p++] = (byte)(w & 0xff);
            }
        }
        
        // Encode Slices
        for (int sampleIdx = 0; sampleIdx < totalSamples; sampleIdx += Qoa.SliceLen)
        {
            for (int c = 0; c < _channels; c++)
            {
                int sliceStart = sampleIdx;
                int sliceLen = Math.Min(Qoa.SliceLen, totalSamples - sliceStart);
                
                long bestError = -1;
                ulong bestSlice = 0;
                QoaLms? bestLms = null;
                
                // Brute force
                for (int sf = 0; sf < 16; sf++)
                {
                    var lms = _lms[c].Clone();
                    long currentError = 0;
                    ulong currentSlice = (ulong)sf << 60;
                    
                    for (int i = 0; i < sliceLen; i++)
                    {
                        int sIdx = (sliceStart + i) * _channels + c;
                        int sample = (int)Math.Clamp(Math.Round(samples[sIdx] * 32768), -32768, 32767);
                        
                        // Predict
                        int prediction = 0;
                        for(int k=0; k<4; k++) prediction += lms.Weights[k] * lms.History[k];
                        prediction >>= 13;
                        
                        int residual = sample - prediction;
                        
                        // Quantize
                        int bestDiff = int.MaxValue;
                        int bestQ = 0;
                        int[] tab = Qoa.DequantTab[sf];
                        
                        for (int q = 0; q < 8; q++)
                        {
                            int diff = Math.Abs(residual - tab[q]);
                            if (diff < bestDiff)
                            {
                                bestDiff = diff;
                                bestQ = q;
                            }
                        }
                        
                        int dequantized = tab[bestQ];
                        int reconstructed = Math.Clamp(prediction + dequantized, -32768, 32767);
                        
                        long err = sample - reconstructed;
                        currentError += err * err;
                        
                        // Pack
                        currentSlice |= (ulong)bestQ << ((19 - i) * 3);
                        
                        // Update
                        int delta = dequantized;
                        for(int k=0; k<4; k++)
                        {
                           lms.Weights[k] += (lms.History[k] < 0 ? -delta : delta) >> 4;
                        }
                        lms.History[0] = lms.History[1];
                        lms.History[1] = lms.History[2];
                        lms.History[2] = lms.History[3];
                        lms.History[3] = reconstructed;
                    }
                    
                    if (bestError == -1 || currentError < bestError)
                    {
                        bestError = currentError;
                        bestSlice = currentSlice;
                        bestLms = lms;
                    }
                }
                
                if (bestLms != null)
                {
                    _lms[c] = bestLms;
                }
                
                // Write slice (Big Endian)
                buffer[p++] = (byte)((bestSlice >> 56) & 0xff);
                buffer[p++] = (byte)((bestSlice >> 48) & 0xff);
                buffer[p++] = (byte)((bestSlice >> 40) & 0xff);
                buffer[p++] = (byte)((bestSlice >> 32) & 0xff);
                buffer[p++] = (byte)((bestSlice >> 24) & 0xff);
                buffer[p++] = (byte)((bestSlice >> 16) & 0xff);
                buffer[p++] = (byte)((bestSlice >> 8) & 0xff);
                buffer[p++] = (byte)(bestSlice & 0xff);
            }
        }
        
        return buffer;
    }
}

public class QoaDecoder 
{
    private QoaLms[] _lms = Array.Empty<QoaLms>();
    
    public QoaDecoder() 
    {
    }
    
    public (float[] Samples, int Channels, int SampleRate)? DecodeFrame(ReadOnlySpan<byte> data)
    {
        if (data.Length < 16) return null;
        
        int p = 0;
        int channels = data[p++];
        int samplerate = (data[p++] << 16) | (data[p++] << 8) | data[p++];
        int fsamples = (data[p++] << 8) | data[p++];
        int frameSize = (data[p++] << 8) | data[p++];
        
        if (channels == 0 || channels > Qoa.MaxChannels) return null;
        
        // Load LMS
        _lms = new QoaLms[channels];
        for (int c = 0; c < channels; c++)
        {
             _lms[c] = new QoaLms();
             for (int i = 0; i < 4; i++)
             {
                 short h = (short)((data[p++] << 8) | data[p++]);
                 _lms[c].History[i] = h;
             }
             for (int i = 0; i < 4; i++)
             {
                 short w = (short)((data[p++] << 8) | data[p++]);
                 _lms[c].Weights[i] = w;
             }
        }
        
        int dataSize = frameSize - 8 - (channels * 16);
        int numSlices = dataSize / 8;
        
        float[] samples = new float[fsamples * channels];
        int sampleIdx = 0;
        
        // Slices
        for (int s = 0; s < numSlices; s++)
        {
            for (int c = 0; c < channels; c++)
            {
                 ulong slice = 
                     ((ulong)data[p++] << 56) |
                     ((ulong)data[p++] << 48) |
                     ((ulong)data[p++] << 40) |
                     ((ulong)data[p++] << 32) |
                     ((ulong)data[p++] << 24) |
                     ((ulong)data[p++] << 16) |
                     ((ulong)data[p++] << 8) |
                     (ulong)data[p++];
                     
                 int sf = (int)((slice >> 60) & 0xf);
                 var lms = _lms[c];
                 int[] tab = Qoa.DequantTab[sf];
                 
                 for (int i = 0; i < 20; i++)
                 {
                     int quantized = (int)((slice >> (19 - i) * 3) & 0x7);
                     
                     int prediction = 0;
                     for(int k=0; k<4; k++) prediction += lms.Weights[k] * lms.History[k];
                     prediction >>= 13;
                     
                     int dequantized = tab[quantized];
                     int reconstructed = Math.Clamp(prediction + dequantized, -32768, 32767);
                     
                     // Update
                     int delta = dequantized;
                     for(int k=0; k<4; k++)
                     {
                        lms.Weights[k] += (lms.History[k] < 0 ? -delta : delta) >> 4;
                     }
                     lms.History[0] = lms.History[1];
                     lms.History[1] = lms.History[2];
                     lms.History[2] = lms.History[3];
                     lms.History[3] = reconstructed;
                     
                     if (sampleIdx < fsamples)
                     {
                         int globalIdx = (s * Qoa.SliceLen + i) * channels + c;
                         if (globalIdx < samples.Length)
                         {
                             samples[globalIdx] = reconstructed / 32768.0f;
                         }
                     }
                 }
            }
        }
        
        return (samples, channels, samplerate);
    }
}
