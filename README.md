# QOV - Quite OK Video

A simple, fast video format inspired by [QOI](https://qoiformat.org/) (Quite OK Image) and [QOA](https://qoaformat.org/) (Quite OK Audio).

## Features

- **Simple format** - Easy to implement encoder/decoder
- **Fast encoding/decoding** - Designed for real-time performance
- **LZ4 compression** - Optional chunk-level compression for smaller files
- **Streaming support** - Progressive loading and on-demand frame decoding
- **Multiple colorspaces** - RGB, RGBA, YUV 4:2:0, YUV 4:2:2, YUV 4:4:4
- **Keyframe seeking** - Efficient random access via keyframe index

## Tools

### Recorder
Capture video from your camera and encode directly to QOV format.

### Player
Play QOV files with detailed statistics including file header info, timeline visualization, and keyframe markers. Supports streaming from URLs.

### Converter
Convert standard video files (MP4, WebM, MPEG, etc.) to QOV format with configurable settings:
- Keyframe interval
- Target frame rate
- Output resolution
- Colorspace selection
- LZ4 compression toggle

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

Then open http://localhost:5173 in your browser.

## Specification

See the full format specification: [qov-specification.md](qov-specification.md)

## File Structure

```
src/
  qov-types.ts          # Type definitions and constants
  qov-encoder.ts        # QOV encoder implementation
  qov-decoder.ts        # QOV decoder (full file)
  qov-streaming-decoder.ts  # Streaming decoder (on-demand)
  lz4.ts                # LZ4 compression/decompression
  color-utils.ts        # YUV/RGB conversion utilities
  player.ts             # Player application
  recorder.ts           # Recorder application
  converter.ts          # Converter application
```

## License

MIT
