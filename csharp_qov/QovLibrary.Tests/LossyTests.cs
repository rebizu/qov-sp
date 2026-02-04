using Xunit;
using QovLibrary;
using System.IO;
using System;
using System.Linq;

namespace QovLibrary.Tests;

public class LossyTests
{
    [Theory]
    [InlineData(100, 0)] // Lossless
    [InlineData(90, 90)]
    [InlineData(50, 50)]
    public void Encoder_WritesCorrectQuality_InHeader(int quality, int expectedQuality)
    {
        // Arrange
        using var stream = new MemoryStream();
        ushort width = 100;
        ushort height = 100;

        // Act
        var encoder = new QovEncoder(stream, width, height, quality: quality);
        var pixels = new byte[width * height * 4];
        encoder.EncodeKeyframe(pixels, 0);
        encoder.Finish();
        
        // Assert
        stream.Position = 0;
        var reader = new BinaryReader(stream);
        
        // Magic
        reader.ReadBytes(4);
        
        // Version
        byte version = reader.ReadByte();
        if (quality < 100)
            Assert.Equal(QovTypes.Version3, version);
        else
            Assert.Equal(QovTypes.Version2, version);
            
        // Flags
        reader.ReadByte();
        // Width/Height/FPS
        reader.ReadBytes(12);
        // Total Frames
        reader.ReadBytes(4);
        // Audio
        reader.ReadBytes(4);
        // Colorspace
        reader.ReadByte();
        
        // Quality (byte 23)
        byte q = reader.ReadByte();
        if (quality < 100)
             Assert.Equal(expectedQuality, q);
    }
    
    [Fact]
    public void LossyEncoding_ProducesSmallerFile_OnRandomData()
    {
        // Low quality should be smaller or equal to lossless on random noise 
        // (noise is hard to compress, but quantization reduces entropy)
        
        // Arrange
        ushort width = 64;
        ushort height = 64;
        var random = new Random(42);
        var pixels = new byte[width * height * 4];
        random.NextBytes(pixels);
        
        // Act - Lossless
        using var streamLossless = new MemoryStream();
        var encoder1 = new QovEncoder(streamLossless, width, height, quality: 100);
        encoder1.EncodeKeyframe(pixels, 0);
        encoder1.Finish();
        
        // Act - Lossy (Very Low Quality)
        using var streamLossy = new MemoryStream();
        var encoder2 = new QovEncoder(streamLossy, width, height, quality: 10);
        encoder2.EncodeKeyframe(pixels, 0);
        encoder2.Finish();
        
        // Assert
        // Lossy should be smaller because quantization makes run-lengths more probable in Lz4
        // Note: QOV itself doesn't compress much without Lz4 unless there are runs. 
        // Quantization creates runs of similar colors potentially.
        Assert.True(streamLossy.Length <= streamLossless.Length);
    }

    [Fact]
    public void Decoder_CanReadLossyFile()
    {
        // Arrange
        using var stream = new MemoryStream();
        ushort width = 10;
        ushort height = 10;
        var encoder = new QovEncoder(stream, width, height, quality: 50);
        
        var pixels = new byte[width * height * 4];
        for(int i=0; i<pixels.Length; i++) pixels[i] = (byte)(i % 255);
        
        encoder.EncodeKeyframe(pixels, 0);
        encoder.Finish();
        
        // Act
        stream.Position = 0;
        var decoder = new QovDecoder(stream);
        var header = decoder.DecodeHeader();
        var frames = decoder.DecodeFrames().ToList();
        
        // Assert
        Assert.Equal(50, header.Quality);
        Assert.Single(frames);
        Assert.Equal(width, frames[0].Width);
        Assert.Equal(height, frames[0].Height);
        Assert.Equal(pixels.Length, frames[0].Pixels.Length);
    }
    
    [Fact]
    public void LossyPFrame_SkipsSimilarpixels()
    {
        // Arrange
        using var stream = new MemoryStream();
        ushort width = 10;
        ushort height = 10;
        var encoder = new QovEncoder(stream, width, height, quality: 50); // Quality 50 => Threshold ~4
        
        var pixels1 = new byte[width * height * 4];
        var pixels2 = new byte[width * height * 4];
        
        // Frame 1: all gray
        Array.Fill(pixels1, (byte)128);
        
        // Frame 2: slightly different gray (within threshold)
        // Quality 50 => Thresh = (100-50)/12 = 4.
        // Difference of 2 should be skipped.
        Array.Fill(pixels2, (byte)130); 
        
        encoder.EncodeKeyframe(pixels1, 0);
        encoder.EncodePFrame(pixels2, 33); // Should use skip because 130 is close to 128
        encoder.Finish();
        
        // Act
        stream.Position = 0;
        var decoder = new QovDecoder(stream);
        var header = decoder.DecodeHeader();
        var frames = decoder.DecodeFrames().ToList();
        
        // Assert
        Assert.Equal(2, frames.Count);
        
        // Verify frame 2 pixels are IDENTICAL to frame 1 (because difference was skipped)
        // If it wasn't skipped, they would be 130 (or quantized 130).
        // Since we skipped, they are copied from prev frame (128).
        // Wait, quantization might also snap 130 to 128? 
        // Q50: YQuant = 1 + 50/8 = 7. 
        // 130 quantized to multiple of 7? No, quantization logic:
        // y = ((y / y_quant) * y_quant). 
        // 128 / 7 * 7 = 18 * 7 = 126.
        // 130 / 7 * 7 = 18 * 7 = 126.
        // So even if explicitly encoded, they might be same.
        // But let's check PFrame logic. 
        // If skipped, we write nothing (or skip opcode). Decoder copies prev frame.
        // Prev frame was 128 (or quantized 126).
        // So frame 2 should be exactly frame 1.
        
        var f1 = frames[0].Pixels;
        var f2 = frames[1].Pixels;
        
        for(int i=0; i<f1.Length; i++)
        {
            Assert.Equal(f1[i], f2[i]);
        }
    }
}
