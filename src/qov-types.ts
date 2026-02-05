// QOV Format Types based on qov-specification.md

export interface QovHeader {
  magic: string;           // "qovf"
  version: number;         // 0x01, 0x02, or 0x03 (lossy)
  flags: number;           // Feature flags bitfield
  width: number;           // 1-65535
  height: number;          // 1-65535
  frameRateNum: number;    // Frame rate numerator
  frameRateDen: number;    // Frame rate denominator
  totalFrames: number;     // 0 = unknown/streaming
  audioChannels: number;   // 0-8
  audioRate: number;       // Sample rate 0-16777215
  colorspace: number;      // Color space identifier
  // Lossy extension (version 0x03)
  quality?: number;        // Quality level 0-100 (100 = near-lossless)
  yQuantBase?: number;     // Y plane base quantization (1-64)
  uvQuantBase?: number;    // UV plane base quantization (1-64)
  temporalThresh?: number; // Temporal similarity threshold (0-32)
  dctQpBase?: number;      // Base QP for DCT blocks (0-51)
}

// Header flags
export const QOV_FLAG_HAS_ALPHA = 0x01;
export const QOV_FLAG_HAS_MOTION = 0x02;
export const QOV_FLAG_HAS_INDEX = 0x04;
export const QOV_FLAG_HAS_BFRAMES = 0x08;
export const QOV_FLAG_ENHANCED_COMP = 0x10;
export const QOV_FLAG_LOSSY_MODE = 0x20;  // Lossy encoding enabled
export const QOV_FLAG_DCT_ENABLED = 0x40; // DCT block encoding available

// Version constants
export const QOV_VERSION_ORIGINAL = 0x01;    // 16-bit chunk sizes, lossless
export const QOV_VERSION_EXTENDED = 0x02;    // 32-bit chunk sizes, lossless
export const QOV_VERSION_LOSSY = 0x03;       // 32-bit chunk sizes, lossy support

// Colorspace values
export const QOV_COLORSPACE_SRGB = 0x00;
export const QOV_COLORSPACE_SRGBA = 0x01;
export const QOV_COLORSPACE_LINEAR = 0x02;
export const QOV_COLORSPACE_LINEAR_A = 0x03;
export const QOV_COLORSPACE_YUV420 = 0x10;
export const QOV_COLORSPACE_YUV422 = 0x11;
export const QOV_COLORSPACE_YUV444 = 0x12;
export const QOV_COLORSPACE_YUVA420 = 0x13;

// Chunk types
export const QOV_CHUNK_SYNC = 0x00;
export const QOV_CHUNK_KEYFRAME = 0x01;
export const QOV_CHUNK_PFRAME = 0x02;
export const QOV_CHUNK_BFRAME = 0x03;
export const QOV_CHUNK_AUDIO = 0x10;
export const QOV_CHUNK_INDEX = 0xF0;
export const QOV_CHUNK_END = 0xFF;

// Chunk flags
export const QOV_CHUNK_FLAG_YUV = 0x01;         // bit 0: YUV mode
export const QOV_CHUNK_FLAG_MOTION = 0x02;      // bit 1: motion vectors
export const QOV_CHUNK_FLAG_COMPRESSED = 0x10;  // bit 4: LZ4 compressed
export const QOV_CHUNK_FLAG_DCT_BLOCKS = 0x20;  // bit 5: DCT blocks

// Compression types (bits 4-5 of chunk flags)
export const QOV_COMPRESSION_NONE = 0x00;
export const QOV_COMPRESSION_LZ4 = 0x10;

// DCT Opcodes (Version 0x03)
export const QOV_OP_DCT_Y = 0x50;
export const QOV_OP_DCT_UV = 0x51;
export const QOV_OP_DCT_SKIP = 0x52;
export const QOV_OP_DCT_ZERO = 0x53;

// Chunk header
export interface QovChunkHeader {
  chunkType: number;
  chunkFlags: number;
  chunkSize: number;
  timestamp: number;          // microseconds
  uncompressedSize?: number;  // only present if compressed
}

// Index entry for seeking
export interface QovIndexEntry {
  frameNum: number;
  fileOffset: bigint;
  timestamp: number;
}

// RGBA pixel
export interface QovRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

// Decoded frame
export interface QovFrame {
  pixels: Uint8ClampedArray;  // RGBA data
  timestamp: number;          // microseconds
  isKeyframe: boolean;
  frameNumber: number;
}

// File statistics for player UI
export interface QovFileStats {
  header: QovHeader;
  fileSize: number;
  chunks: QovChunkInfo[];
  keyframeIndices: number[];
  indexTable: QovIndexEntry[];
  duration: number;          // microseconds
}

export interface QovChunkInfo {
  type: number;
  typeName: string;
  offset: number;
  size: number;
  timestamp: number;
  isKeyframe: boolean;
  isCompressed?: boolean;
  uncompressedSize?: number;
}

export function getChunkTypeName(type: number | undefined): string {
  if (type === undefined || type === null) {
    return 'INVALID(undefined)';
  }
  switch (type) {
    case QOV_CHUNK_SYNC: return 'SYNC';
    case QOV_CHUNK_KEYFRAME: return 'KEYFRAME';
    case QOV_CHUNK_PFRAME: return 'PFRAME';
    case QOV_CHUNK_BFRAME: return 'BFRAME';
    case QOV_CHUNK_AUDIO: return 'AUDIO';
    case QOV_CHUNK_INDEX: return 'INDEX';
    case QOV_CHUNK_END: return 'END';
    default: return `UNKNOWN(0x${type.toString(16)})`;
  }
}

// Lossy encoding parameters
export interface LossyParams {
  yQuant: number;        // Y plane quantization step (1-64)
  uvQuant: number;       // UV plane quantization step (1-64)
  temporalThresh: number; // Temporal similarity threshold (0-32)
  dctQp: number;         // DCT quantization parameter (0-51)
}

// Derive lossy parameters from quality level (0-100)
export function deriveLossyParams(quality: number): LossyParams {
  // Clamp quality to valid range
  quality = Math.max(0, Math.min(100, quality));

  // Y plane quantization (preserve luminance detail)
  const yQuant = Math.max(1, Math.min(64, 1 + Math.floor((100 - quality) / 8)));

  // UV plane quantization (can be more aggressive)
  const uvQuant = Math.max(1, Math.min(64, 2 + Math.floor((100 - quality) / 4)));

  // Temporal similarity threshold for P-frames
  const temporalThresh = Math.max(0, Math.min(32, Math.floor((100 - quality) / 12)));

  // DCT quantization parameter (if DCT enabled)
  const dctQp = Math.max(0, Math.min(51, 51 - Math.floor(quality * 51 / 100)));

  return { yQuant, uvQuant, temporalThresh, dctQp };
}

// Get quality level name
export function getQualityName(quality: number): string {
  if (quality >= 95) return 'Near-lossless';
  if (quality >= 85) return 'High';
  if (quality >= 70) return 'Medium-High';
  if (quality >= 50) return 'Medium';
  if (quality >= 30) return 'Low';
  return 'Very Low';
}
