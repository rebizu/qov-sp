# QOV C# Library

A .NET 8.0 implementation of the Quite OK Video (QOV) format with encoding, decoding, and visualization capabilities.

## Features

- **Full QOV Specification 1.0 Support**:
  - RGB (sRGB/sRGBA) and YUV (4:2:0, 4:2:2, 4:4:4) color modes
  - Keyframe (I-frame) and P-frame temporal compression
  - LZ4 block compression (auto-selected based on efficiency)
  - Index table for fast seeking
  - Sync markers for streaming support

- **Cross-Platform .NET 8.0**:
  - NetStandard 2.0+ compatible
  - Works on Windows, Linux, macOS
  - No native dependencies for core library

- **Practical Tools**:
  - QovPlayer: Console-based video playback
  - QovEncoder: Convert image sequences to QOV
  - QovScreenRecorder: Record screen activity to QOV

- **Stream-Based Architecture**:
  - Encoder writes directly to streams
  - Supports large files without memory issues
  - Async-ready for network streaming

## Building

```bash
cd csharp_qov
dotnet build
```

## Running Tests

```bash
dotnet test
```

## Usage Examples

### Basic Encoding

```csharp
using var stream = File.Create("output.qov");
var encoder = new QovEncoder(stream, 640, 480, 30, 1,
    QovTypes.FlagHasIndex, QovTypes.ColorspaceSrgb);

// Encode frames
for (int i = 0; i < 300; i++)
{
    byte[] pixels = GetFramePixels();
    ulong timestamp = (ulong)(i * 1000000 / 30);

    if (i % 30 == 0)
    {
        encoder.EncodeKeyframe(pixels, (uint)timestamp);
    }
    else
    {
        encoder.EncodePFrame(pixels, (uint)timestamp);
    }
}

encoder.Finish();
```

### Basic Decoding

```csharp
using var stream = File.OpenRead("input.qov");
var decoder = new QovDecoder(stream);

var header = decoder.DecodeHeader();
Console.WriteLine($"Resolution: {header.Width}x{header.Height}");

foreach (var frame in decoder.DecodeFrames())
{
    // Process frame:
    // - frame.Pixels contains RGBA data
    // - frame.IsKeyframe indicates keyframe
    // - frame.Timestamp in microseconds
}
```

### Player Tool

```bash
# Show file info
QovPlayer --file video.qov --info

# Play at 30 fps
QovPlayer --file video.qov --fps 30
```

### Encoder Tool

```bash
# Encode image sequence
QovEncoder --output video.qov --width 1920 --height 1080 \
    --images ./frames/ --pattern "frame_*.png" \
    --fps 30 --colorspace yuv420

# Generate test video
QovEncoder --output test.qov --width 640 --height 480 --fps 30
```

### Screen Recorder

```bash
QovScreenRecorder
# Follow prompts to configure and record
```

## Library Structure

```
csharp_qov/
├── QovLibrary/          # Core library
│   ├── QovTypes.cs      # Constants and types
│   ├── QovEncoder.cs    # Stream-based encoder
│   ├── QovDecoder.cs    # Full-file decoder
│   ├── Lz4Compression.cs      # LZ4 compression
│   └── ColorConversion.cs     # YUV/RGB conversion
│
├── QovLibrary.Tests/    # xUnit tests
├── QovPlayer/           # Console player
├── QovEncoder/          # Image encoder
└── QovScreenRecorder/   # Screen recorder
```

## Color Space Support

| Color Space | Description | Usage |
|------------|-------------|-------|
| `ColorspaceSrgb` | sRGB RGB/RGB opcodes | Default, best quality |
| `ColorspaceSrgba` | sRGB + Alpha | Transparency support |
| `ColorspaceYuv420` | BT.601 YCbCr 4:2:0 | Small file size |
| `ColorspaceYuv422` | BT.601 YCbCr 4:2:2 | Balance quality/size |
| `ColorspaceYuv444` | BT.601 YCbCr 4:4:4 | High quality video |
| `ColorspaceYuva420` | YUV 4:2:0 + Alpha | Small size with alpha |

## Performance Considerations

- **Keyframe Interval**: Every 30-60 frames (1-2 seconds at 30fps)
- **P-frames**: Provide 2-10x compression over raw keyframes
- **LZ4 Compression**: Enabled by default, auto-skipped if <5% savings
- **Memory**: Encoder uses streams directly, no full-buffer loading
- **Async**: Decoder supports streaming with `CancellationToken`

## Format Compliance

The implementation follows QOV specification version 1.0:
- File header (24 bytes) with magic "qovf"
- Chunk-based structure with 32-bit chunk sizes (v2)
- QOI-compatible RGB opcodes
- Simplified YUV plane opcodes
- LZ4 block compression (optional per-chunk)

## License

This implementation follows the same philosophy as QOV: simple, fast, and freely available.