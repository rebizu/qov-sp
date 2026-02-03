# QOV - Quite OK Video

A simple, fast video format inspired by [QOI](https://qoiformat.org/) (Quite OK Image) and [QOA](https://qoaformat.org/) (Quite OK Audio).

## Features

- **Simple format** - Easy to implement encoder/decoder
- **Fast encoding/decoding** - Designed for real-time performance
- **LZ4 compression** - Optional chunk-level compression for smaller files
- **Streaming support** - Progressive loading and on-demand frame decoding
- **Multiple colorspaces** - RGB, RGBA, YUV 4:2:0, YUV 4:2:2, YUV 4:4:4
- **Alpha channel support** - Transparent video with RGBA and YUVA420 modes
- **Keyframe seeking** - Efficient random access via keyframe index
- **Cross-platform** - TypeScript/JavaScript and C#/.NET implementations

## Implementations

### TypeScript/JavaScript (Web-based)

Browser-based tools built with TypeScript and WebCodecs.

#### Tools

**Recorder**
Capture video from your camera and encode directly to QOV format.

**Player**
Play QOV files with detailed statistics including file header info, timeline visualization, and keyframe markers. Supports streaming from URLs.

**Converter**
Convert standard video files (MP4, WebM, MPEG, etc.) to QOV format with configurable settings:
- Keyframe interval
- Target frame rate
- Output resolution
- Colorspace selection
- LZ4 compression toggle

#### Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

Then open http://localhost:5173 in your browser.

### C#/.NET Implementation

A complete .NET 8.0 implementation with encoding, decoding, and command-line tools. Located in the `csharp_qov/` directory.

#### Features

- Full QOV Specification 1.0 support
- Stream-based encoding/decoding for efficient memory usage
- Cross-platform (Windows, Linux, macOS)
- Command-line tools for encoding, playback, and screen recording
- Comprehensive test suite

#### Tools

- **QovPlayer** - Console-based video playback
- **QovEncoder** - Convert image sequences to QOV
- **QovScreenRecorder** - Record screen activity to QOV format
- **QovValidator** - Validate QOV file format compliance

#### Getting Started

```bash
cd csharp_qov
dotnet build
dotnet test

# Run tools
dotnet run --project QovPlayer -- --file video.qov --info
dotnet run --project QovEncoder -- --help
```

See [csharp_qov/README.md](csharp_qov/README.md) for detailed documentation and usage examples.

## Specification

See the full format specification: [qov-specification.md](qov-specification.md)

## Repository Structure

```
src/                      # TypeScript/JavaScript implementation
  qov-types.ts            # Type definitions and constants
  qov-encoder.ts          # QOV encoder implementation
  qov-decoder.ts          # QOV decoder (full file)
  qov-streaming-decoder.ts # Streaming decoder (on-demand)
  lz4.ts                  # LZ4 compression/decompression
  color-utils.ts          # YUV/RGB conversion utilities
  player.ts               # Player application
  recorder.ts             # Recorder application
  converter.ts            # Converter application

csharp_qov/               # C#/.NET implementation
  QovLibrary/             # Core encoding/decoding library
  QovPlayer/              # Console video player
  QovEncoder/             # Image sequence encoder
  QovScreenRecorder/      # Screen recording tool
  QovValidator/           # Format validation tool
  QovLibrary.Tests/       # Test suite
```

## License

MIT
