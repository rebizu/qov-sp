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

export function getChunkTypeName(type: number): string {
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
