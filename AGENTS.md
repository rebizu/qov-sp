# AGENTS.md - QOV (Quite OK Video) Project

## Build Commands

```bash
# Development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Type checking
npx tsc --noEmit
```

## Code Style Guidelines

### TypeScript Configuration
- Target: ES2020
- Module system: ESNext
- Strict mode enabled
- Type checking: NO unused locals/params, NO fallthrough cases
- File extension: `.ts` for source files

### Imports
- Use named imports: `import { QovHeader, QovFrame } from './qov-types'`
- Local files use relative paths with `./` prefix
- Third-party dependencies in node_modules (e.g., `lz4Decompress` from `'./lz4'`)

### Naming Conventions
- **Classes**: PascalCase (`QovEncoder`, `QovDecoder`)
- **Interfaces**: PascalCase (`QovHeader`, `QovFrame`)
- **Functions/Methods**: camelCase (`encodeKeyframe`, `decodeFrame`)
- **Variables**: camelCase (`frameCount`, `currentFrame`)
- **Constants**: UPPER_SNAKE_CASE (`QOV_FLAG_HAS_ALPHA`, `QOV_CHUNK_KEYFRAME`)
- **Private members**: No special prefix (TS compiler enforces visibility)

### Formatting
- Indentation: 2 spaces (observed in existing code)
- No trailing whitespace
- Max line length: ~120 characters (soft limit)
- No comments unless explicitly requested

### Binary Data Handling
- Use `Uint8Array` for raw byte data
- Use `Uint8ClampedArray` for RGBA pixel data
- Use `bigint` for file offsets in index tables
- Bitwise operations with `& 0xff` masking for byte extraction

### Error Handling
- Use `try/catch` for async operations
- Throw `Error` objects with descriptive messages
- Use `console.error()` for error logging
- Use `console.log()` with prefixes like `[Encoder]`, `[Decoder]` for debug logging
- User-facing errors via `alert()` in browser code

### TypeScript Types
- Always type function parameters and return values
- Use interfaces for data structures
- Use type annotations for complex types
- Non-null assertion operator `!` when null is impossible
- Default parameter values where appropriate

### Constants
Magic numbers and format constants defined in `qov-types.ts`:
- Export `const` values for all QOV flags, chunk types, opcodes
- Use meaningful names (e.g., `QOV_CHUNK_SYNC` not `0x00`)

### Class Design
- Private fields for internal state
- Public methods for external API
- Use `this.` consistently for all member access
- Initialize all fields in constructor

### Performance Considerations
- Pre-allocate typed arrays with known sizes
- Use `for` loops instead of `forEach` for performance-critical code
- Cache length references in loop conditions
- Avoid object creation in hot loops

### Browser APIs
- Use `navigator.mediaDevices.getUserMedia` for camera
- Use `requestAnimationFrame` for animation loops
- Use `performance.now()` for timing
- Event listeners at module level (bott declarations)

### File Organization
```
src/
  qov-types.ts           # Type definitions and constants
  qov-encoder.ts         # QOV encoding implementation
  qov-decoder.ts         # QOV decoding (full file)
  qov-streaming-decoder.ts # Streaming decoder with seeking
  lz4.ts                 # LZ4 compression/decompression
  color-utils.ts         # YUV/RGB conversion utilities
  player.ts              # Player UI and logic
  recorder.ts            # Recorder UI and logic
  converter.ts           # Video converter
```

### Testing
Conformance suite (golden corpus + multi-implementation runner):
- `npm run conformance` (or `python qov-analysis-tools/conformance.py`) — runs every implementation against the frozen corpus in `qov-analysis-tools/corpus/`
- TS-only run: add `--skip-csharp`; single case: `--only <case-id>`
- Codec changes that intentionally alter output require `npm run corpus` with `--force` (approval test — review the manifest diff)
- Failures that are permanent, documented limitations go in `qov-analysis-tools/expected_failures.json` with a measured reason; the runner warns when such entries go stale
- See `qov-analysis-tools/README.md` for the full workflow

### Commit Guidelines
- Use conventional commits format
- Reference relevant specification sections in commit messages
- Keep commits focused and atomic

### Development Notes
- Vite dev server runs on all network interfaces (host: true)
- Multi-page build with entry points: index.html, recorder.html, player.html, converter.html, spec.html, diagnose.html
- Build outputs to `dist/` directory
- `tsc` type-checks only (`noEmit`); Vite emits the JavaScript during build