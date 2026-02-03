// QOV Format Types based on qov-specification.md

export interface QovHeader {
  magic: string;           // "qovf"
  version: number;         // 0x01
  flags: number;           // Feature flags bitfield
  width: number;           // 1-65535
  height: number;          // 1-65535
  frameRateNum: number;    // Frame rate numerator
  frameRateDen: number;    // Frame rate denominator
  totalFrames: number;     // 0 = unknown/streaming
  audioChannels: number;   // 0-8
  audioRate: number;       // Sample rate 0-16777215
  colorspace: number;      // Color space identifier
}

// Header flags
export const QOV_FLAG_HAS_ALPHA = 0x01;
export const QOV_FLAG_HAS_MOTION = 0x02;
export const QOV_FLAG_HAS_INDEX = 0x04;
export const QOV_FLAG_HAS_BFRAMES = 0x08;
export const QOV_FLAG_ENHANCED_COMP = 0x10;
export const QOV_FLAG_LOSSY_MODE = 0x20;   // Lossy encoding enabled
export const QOV_FLAG_DCT_ENABLED = 0x40;  // DCT block encoding available

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

// Compression types (bits 4-5 of chunk flags)
export const QOV_COMPRESSION_NONE = 0x00;
export const QOV_COMPRESSION_LZ4 = 0x10;

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

// =============================================================================
// Lossy Encoding Types and Interfaces
// =============================================================================

/**
 * Lossy encoding quality parameters
 * Derived from quality level (0-100) or set explicitly
 */
export interface QovLossyParams {
  /** Quality level 0-100 (100 = near-lossless) */
  quality: number;
  /** Y plane quantization step (1-64, lower = better quality) */
  yQuant: number;
  /** UV plane quantization step (1-64, can be more aggressive) */
  uvQuant: number;
  /** Temporal similarity threshold for P-frames (0-32) */
  temporalThreshold: number;
  /** DCT quantization parameter (0-51, only used if DCT enabled) */
  dctQp: number;
}

/**
 * Extended header for lossy QOV (version 0x03)
 * 32 bytes total vs 24 bytes for lossless
 */
export interface QovLossyHeader extends QovHeader {
  /** Quality level 0-100 (byte 23) */
  quality: number;
  /** Y plane base quantization (byte 24) */
  yQuantBase: number;
  /** UV plane base quantization (byte 25) */
  uvQuantBase: number;
  /** Temporal similarity threshold (byte 26) */
  temporalThreshold: number;
  /** Base QP for DCT blocks (byte 27) */
  dctQpBase: number;
}

/**
 * Quality preset names for user-friendly selection
 */
export type QovQualityPreset =
  | 'lossless'      // quality 100
  | 'near-lossless' // quality 95
  | 'high'          // quality 85
  | 'medium-high'   // quality 75
  | 'medium'        // quality 60
  | 'low'           // quality 40
  | 'very-low';     // quality 20

/**
 * Quality preset definitions
 */
export const QOV_QUALITY_PRESETS: Record<QovQualityPreset, number> = {
  'lossless': 100,
  'near-lossless': 95,
  'high': 85,
  'medium-high': 75,
  'medium': 60,
  'low': 40,
  'very-low': 20,
};

/**
 * Derive lossy parameters from quality level
 */
export function deriveLossyParams(quality: number): QovLossyParams {
  // Clamp quality to valid range
  quality = Math.max(0, Math.min(100, quality));

  // Y plane quantization (preserve luminance detail)
  // quality 100 -> yQuant 1, quality 0 -> yQuant 13
  const yQuant = Math.max(1, Math.min(64, 1 + Math.floor((100 - quality) / 8)));

  // UV plane quantization (can be more aggressive)
  // quality 100 -> uvQuant 2, quality 0 -> uvQuant 27
  const uvQuant = Math.max(1, Math.min(64, 2 + Math.floor((100 - quality) / 4)));

  // Temporal similarity threshold for P-frames
  // quality 100 -> threshold 0, quality 0 -> threshold 8
  const temporalThreshold = Math.max(0, Math.min(32, Math.floor((100 - quality) / 12)));

  // DCT quantization parameter (if DCT enabled)
  // quality 100 -> dctQp 0, quality 0 -> dctQp 51
  const dctQp = Math.max(0, Math.min(51, 51 - Math.floor(quality * 51 / 100)));

  return {
    quality,
    yQuant,
    uvQuant,
    temporalThreshold,
    dctQp,
  };
}

/**
 * Encoding statistics for lossy encoder
 */
export interface QovLossyStats {
  /** Total pixels encoded */
  totalPixels: number;
  /** Pixels skipped due to temporal similarity */
  skippedPixels: number;
  /** Pixels encoded with quantization */
  quantizedPixels: number;
  /** Original uncompressed size */
  uncompressedSize: number;
  /** Final compressed size */
  compressedSize: number;
  /** Compression ratio */
  compressionRatio: number;
  /** Estimated PSNR (if original available) */
  estimatedPsnr?: number;
}
