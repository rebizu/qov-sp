# GEMINI.md

## Project Overview

This project implements the **QOV (Quite OK Video)** format, a simple and fast video format inspired by QOI and QOA. It is designed for real-time performance and ease of implementation.

Key features include:
*   Simple and easy-to-implement format
*   Fast encoding/decoding
*   Optional LZ4 compression
*   Streaming support
*   Multiple colorspaces (RGB, RGBA, YUV 4:2:0, YUV 4:2:2, YUV 4:4:4)
*   Alpha channel support
*   Keyframe seeking for efficient random access
*   Cross-platform implementations in TypeScript/JavaScript and C#/.NET

The project consists of two main implementations:
1.  **TypeScript/JavaScript (Web-based):** Provides browser-based tools for recording, playing, and converting QOV videos, utilizing WebCodecs.
2.  **C#/.NET Implementation:** Offers a complete .NET 10.0 library for encoding and decoding QOV, along with command-line tools for various video operations.

## Building and Running

### TypeScript/JavaScript (Web-based Tools)

This part of the project is built with TypeScript and Vite, providing web-based tools for QOV video manipulation.

*   **Technologies Used:** TypeScript, Vite, WebCodecs.
*   **Available Tools:** Recorder, Player, Converter.

**Setup & Development:**

To set up the project and run the development server:

```bash
npm install
npm run dev
```

After running `npm run dev`, open `http://localhost:5173` in your browser to access the web tools.

**Production Build:**

To create a production-ready build of the web application:

```bash
npm run build
```

The build output will be located in the `dist/` directory.

### C#/.NET Implementation

This implementation provides a robust .NET 10.0 library for QOV encoding/decoding and various command-line utilities.

*   **Technologies Used:** .NET 10.0, C#.
*   **Available Tools:** `QovPlayer` (console-based video playback), `QovEncoder` (image sequence to QOV), `QovScreenRecorder` (screen recording to QOV), `QovValidator` (QOV file format compliance).

**Setup & Development:**

To build the C# projects and run their tests:

```bash
cd csharp_qov
dotnet build
dotnet test
```

**Running Tools (Examples):**

You can run the command-line tools directly from the `csharp_qov` directory. Here are some examples:

```bash
# Get information about a QOV file using QovPlayer
dotnet run --project QovPlayer -- --file video.qov --info

# Display help for the QovEncoder
dotnet run --project QovEncoder -- --help
```

For more detailed documentation and usage examples for the C# implementation, refer to `csharp_qov/README.md`.

## Development Conventions

### TypeScript/JavaScript

*   **Language:** TypeScript, targeting ES2020.
*   **Build Tool:** Vite for development and bundling.
*   **Type Checking:** Strict type checking is enforced (`"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`).
*   **Code Style:** Adheres to modern TypeScript practices, with `forceConsistentCasingInFileNames` enabled.

### C#/.NET

*   **Language:** C# with `LangVersion` set to `latest`.
*   **Framework:** .NET 10.0.
*   **Modern Features:** Utilizes `ImplicitUsings` and `Nullable` reference types for cleaner, safer code.
*   **Performance:** `AllowUnsafeBlocks` is enabled, suggesting the use of `unsafe` code blocks for performance-critical operations, common in multimedia processing.
*   **Documentation:** XML documentation file generation is enabled, promoting well-documented code.
