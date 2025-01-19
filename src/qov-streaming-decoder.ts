// QOV Streaming Decoder - Decodes frames on-demand for streaming playback

import {
  QovHeader,
  QovFrame,
  QovFileStats,
  QovChunkInfo,
  QovRGBA,
  QOV_CHUNK_KEYFRAME,
  QOV_CHUNK_PFRAME,
  QOV_CHUNK_BFRAME,
  QOV_CHUNK_END,
  QOV_COLORSPACE_YUV420,
  QOV_COLORSPACE_YUV422,
  QOV_COLORSPACE_YUVA420,
  QOV_CHUNK_FLAG_COMPRESSED,
  getChunkTypeName,
} from './qov-types';

import { lz4Decompress } from './lz4';

import {
  yuv420PlanesToRgba,
  yuv422PlanesToRgba,
  yuv444PlanesToRgba,
} from './color-utils';

// Chunk metadata for seeking
interface ChunkMeta {
  offset: number;
  type: number;
  flags: number;
  size: number;
  timestamp: number;
  frameIndex: number;  // -1 for non-frame chunks
}

// Data source interface for streaming
export interface StreamDataSource {
  // Get total size (may be unknown for live streams)
  getSize(): number | null;
  // Read bytes from offset
  read(offset: number, length: number): Promise<Uint8Array>;
  // Check if data is available at offset
  isAvailable(offset: number, length: number): boolean;
  // Get amount of data loaded so far
  getLoadedSize(): number;
}

// File-based data source (entire file in memory)
export class FileDataSource implements StreamDataSource {
  private data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  getSize(): number {
    return this.data.length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.subarray(offset, offset + length);
  }

  isAvailable(offset: number, length: number): boolean {
    return offset + length <= this.data.length;
  }

  getLoadedSize(): number {
    return this.data.length;
  }
}

// URL-based data source with progressive loading
export class UrlDataSource implements StreamDataSource {
  private url: string;
  private buffer: Uint8Array | null = null;
  private loadedSize = 0;
  private totalSize: number | null = null;
  private loading = false;
  private loadPromise: Promise<void> | null = null;

  constructor(url: string) {
    this.url = url;
  }

  async init(): Promise<void> {
    // Get file size with HEAD request
    try {
      const response = await fetch(this.url, { method: 'HEAD' });
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        this.totalSize = parseInt(contentLength, 10);
        this.buffer = new Uint8Array(this.totalSize);
      }
    } catch (e) {
      console.warn('[UrlDataSource] HEAD request failed, will determine size during download');
    }

    // Start progressive download
    this.startDownload();
  }

  private async startDownload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;

    this.loadPromise = (async () => {
      try {
        const response = await fetch(this.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        // If we didn't get size from HEAD, get it from response
        if (this.totalSize === null) {
          const contentLength = response.headers.get('content-length');
          if (contentLength) {
            this.totalSize = parseInt(contentLength, 10);
            this.buffer = new Uint8Array(this.totalSize);
          }
        }

        // Read chunks progressively
        const chunks: Uint8Array[] = [];
        let totalRead = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (this.buffer && this.totalSize) {
            // Copy to pre-allocated buffer
            this.buffer.set(value, totalRead);
          } else {
            // Accumulate chunks (unknown size)
            chunks.push(value);
          }

          totalRead += value.length;
          this.loadedSize = totalRead;
        }

        // If we didn't pre-allocate, concatenate chunks now
        if (!this.buffer) {
          this.totalSize = totalRead;
          this.buffer = new Uint8Array(totalRead);
          let offset = 0;
          for (const chunk of chunks) {
            this.buffer.set(chunk, offset);
            offset += chunk.length;
          }
        }

        this.loadedSize = this.totalSize!;
      } catch (e) {
        console.error('[UrlDataSource] Download error:', e);
        throw e;
      } finally {
        this.loading = false;
      }
    })();
  }

  getSize(): number | null {
    return this.totalSize;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    // Wait for enough data to be available
    while (this.loadedSize < offset + length && this.loading) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!this.buffer || offset + length > this.buffer.length) {
      throw new Error(`Cannot read ${length} bytes at offset ${offset}`);
    }

    return this.buffer.subarray(offset, offset + length);
  }

  isAvailable(offset: number, length: number): boolean {
    return this.loadedSize >= offset + length;
  }

  getLoadedSize(): number {
    return this.loadedSize;
  }

  // Wait for download to complete
  async waitForComplete(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
    }
  }
}

export class QovStreamingDecoder {
  private source: StreamDataSource;
  private header: QovHeader | null = null;
  private chunks: ChunkMeta[] = [];
  private keyframeIndices: number[] = [];  // Frame indices that are keyframes
  private totalFrames = 0;
  private use32BitChunkSize = false;
  private headerParsed = false;
  private indexBuilt = false;

  // Decoder state
  private index: QovRGBA[] = new Array(64);
  private prevPixel: QovRGBA = { r: 0, g: 0, b: 0, a: 255 };
  private prevFrame: Uint8ClampedArray | null = null;
  private currFrame: Uint8ClampedArray | null = null;
  private lastDecodedFrameIndex = -1;
  private decoding = false;  // Lock to prevent concurrent decoding

  // YUV state
  private isYuvMode = false;
  private hasYuvAlpha = false;
  private prevYPlane: Uint8Array | null = null;
  private prevUPlane: Uint8Array | null = null;
  private prevVPlane: Uint8Array | null = null;
  private prevAPlane: Uint8Array | null = null;
  private currYPlane: Uint8Array | null = null;
  private currUPlane: Uint8Array | null = null;
  private currVPlane: Uint8Array | null = null;
  private currAPlane: Uint8Array | null = null;

  // For decompression
  private activeData: Uint8Array | null = null;
  private activePos = 0;

  // Callbacks
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void;
  onHeaderReady?: (header: QovHeader) => void;
  onFrameReady?: (frameIndex: number, totalFrames: number) => void;

  constructor(source: StreamDataSource) {
    this.source = source;
    this.resetIndex();
  }

  private resetIndex(): void {
    for (let i = 0; i < 64; i++) {
      this.index[i] = { r: 0, g: 0, b: 0, a: 0 };
    }
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };
  }

  // Parse file header
  async parseHeader(): Promise<QovHeader> {
    if (this.header) return this.header;

    const headerData = await this.source.read(0, 24);

    // Check magic
    const magic = String.fromCharCode(headerData[0], headerData[1], headerData[2], headerData[3]);
    if (magic !== 'qovf') {
      throw new Error(`Invalid QOV magic: ${magic}`);
    }

    const version = headerData[4];
    if (version !== 0x01 && version !== 0x02) {
      throw new Error(`Unsupported QOV version: ${version}`);
    }
    this.use32BitChunkSize = version >= 0x02;

    this.header = {
      magic,
      version,
      flags: headerData[5],
      width: (headerData[6] << 8) | headerData[7],
      height: (headerData[8] << 8) | headerData[9],
      frameRateNum: (headerData[10] << 8) | headerData[11],
      frameRateDen: (headerData[12] << 8) | headerData[13],
      totalFrames: (headerData[14] << 24) | (headerData[15] << 16) | (headerData[16] << 8) | headerData[17],
      audioChannels: headerData[18],
      audioRate: (headerData[19] << 16) | (headerData[20] << 8) | headerData[21],
      colorspace: headerData[22],
    };

    // Detect YUV mode
    const cs = this.header.colorspace;
    this.isYuvMode = cs >= QOV_COLORSPACE_YUV420 && cs <= QOV_COLORSPACE_YUVA420;
    this.hasYuvAlpha = cs === QOV_COLORSPACE_YUVA420;

    // Initialize frame buffers with opaque black (alpha = 255)
    const pixelCount = this.header.width * this.header.height * 4;
    this.prevFrame = new Uint8ClampedArray(pixelCount);
    this.currFrame = new Uint8ClampedArray(pixelCount);

    // Set alpha to 255 for all pixels (every 4th byte starting at index 3)
    for (let i = 3; i < pixelCount; i += 4) {
      this.prevFrame[i] = 255;
      this.currFrame[i] = 255;
    }

    // Initialize YUV planes if needed
    if (this.isYuvMode) {
      this.initYuvPlanes();
    }

    this.headerParsed = true;
    this.onHeaderReady?.(this.header);

    return this.header;
  }

  private initYuvPlanes(): void {
    if (!this.header) return;

    const { width, height, colorspace } = this.header;
    const ySize = width * height;

    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    this.prevYPlane = new Uint8Array(ySize);
    this.prevUPlane = new Uint8Array(uvSize);
    this.prevVPlane = new Uint8Array(uvSize);
    this.currYPlane = new Uint8Array(ySize);
    this.currUPlane = new Uint8Array(uvSize);
    this.currVPlane = new Uint8Array(uvSize);

    if (this.hasYuvAlpha) {
      this.prevAPlane = new Uint8Array(ySize);
      this.currAPlane = new Uint8Array(ySize);
    }
  }

  // Build chunk index by scanning file
  async buildIndex(): Promise<void> {
    if (this.indexBuilt) return;
    if (!this.header) await this.parseHeader();

    this.chunks = [];
    this.keyframeIndices = [];
    this.totalFrames = 0;

    let offset = 24; // After header
    const fileSize = this.source.getSize();

    while (fileSize === null || offset < fileSize) {
      // Wait for chunk header to be available
      const headerSize = this.use32BitChunkSize ? 10 : 8;
      if (!this.source.isAvailable(offset, headerSize)) {
        // Wait for more data
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const headerData = await this.source.read(offset, headerSize);
      const chunkType = headerData[0];
      const chunkFlags = headerData[1];
      let chunkSize: number;
      let timestamp: number;

      if (this.use32BitChunkSize) {
        chunkSize = (headerData[2] << 24) | (headerData[3] << 16) | (headerData[4] << 8) | headerData[5];
        timestamp = (headerData[6] << 24) | (headerData[7] << 16) | (headerData[8] << 8) | headerData[9];
      } else {
        chunkSize = (headerData[2] << 8) | headerData[3];
        timestamp = (headerData[4] << 24) | (headerData[5] << 16) | (headerData[6] << 8) | headerData[7];
      }

      // Handle compressed chunks - uncompressed size is at start of data
      if (chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) {
        // Need to account for uncompressed_size field in the chunk
      }

      let frameIndex = -1;
      if (chunkType === QOV_CHUNK_KEYFRAME) {
        frameIndex = this.totalFrames;
        this.keyframeIndices.push(this.totalFrames);
        this.totalFrames++;
      } else if (chunkType === QOV_CHUNK_PFRAME || chunkType === QOV_CHUNK_BFRAME) {
        frameIndex = this.totalFrames;
        this.totalFrames++;
      }

      this.chunks.push({
        offset,
        type: chunkType,
        flags: chunkFlags,
        size: chunkSize + headerSize,
        timestamp,
        frameIndex,
      });

      if (chunkType === QOV_CHUNK_END) {
        break;
      }

      offset += headerSize + chunkSize;
      this.onFrameReady?.(this.totalFrames, this.header?.totalFrames || this.totalFrames);
      this.onProgress?.(this.source.getLoadedSize(), this.source.getSize());
    }

    this.indexBuilt = true;
  }

  // Get frame count (may increase during streaming)
  getFrameCount(): number {
    return this.totalFrames;
  }

  // Get keyframe indices
  getKeyframeIndices(): number[] {
    return [...this.keyframeIndices];
  }

  // Find the keyframe at or before the given frame index
  findPrecedingKeyframe(frameIndex: number): number {
    let keyframeIdx = 0;
    for (const kf of this.keyframeIndices) {
      if (kf <= frameIndex) {
        keyframeIdx = kf;
      } else {
        break;
      }
    }
    return keyframeIdx;
  }

  // Decode a specific frame
  async decodeFrame(frameIndex: number): Promise<QovFrame | null> {
    // Wait if another decode is in progress (prevent race conditions)
    while (this.decoding) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    this.decoding = true;

    try {
      if (!this.header) await this.parseHeader();
      if (!this.indexBuilt) await this.buildIndex();

      if (frameIndex < 0 || frameIndex >= this.totalFrames) {
        return null;
      }

      // If we need to seek backward or forward past last decoded frame,
      // we need to start from a keyframe
      if (frameIndex <= this.lastDecodedFrameIndex - 1 ||
          frameIndex > this.lastDecodedFrameIndex + 1) {
        const keyframeIdx = this.findPrecedingKeyframe(frameIndex);

        // Reset decoder state and decode from keyframe
        this.resetIndex();
        this.lastDecodedFrameIndex = keyframeIdx - 1;

        // Decode from keyframe to target
        for (let i = keyframeIdx; i <= frameIndex; i++) {
          await this.decodeNextFrame(i);
        }
      } else if (frameIndex === this.lastDecodedFrameIndex + 1) {
        // Sequential playback - decode next frame
        await this.decodeNextFrame(frameIndex);
      }
      // If frameIndex === lastDecodedFrameIndex, return cached frame

      return {
        pixels: new Uint8ClampedArray(this.prevFrame!),
        timestamp: this.getFrameTimestamp(frameIndex),
        isKeyframe: this.keyframeIndices.includes(frameIndex),
        frameNumber: frameIndex,
      };
    } finally {
      this.decoding = false;
    }
  }

  private getFrameTimestamp(frameIndex: number): number {
    for (const chunk of this.chunks) {
      if (chunk.frameIndex === frameIndex) {
        return chunk.timestamp;
      }
    }
    return 0;
  }

  private async decodeNextFrame(frameIndex: number): Promise<void> {
    // Find chunk for this frame
    const chunk = this.chunks.find(c => c.frameIndex === frameIndex);
    if (!chunk) {
      throw new Error(`No chunk found for frame ${frameIndex}`);
    }

    // Read chunk data
    const headerSize = this.use32BitChunkSize ? 10 : 8;
    const dataSize = chunk.size - headerSize;
    let chunkData = await this.source.read(chunk.offset + headerSize, dataSize);

    const isCompressed = (chunk.flags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
    const isYuvChunk = (chunk.flags & 0x01) !== 0;

    // Handle decompression
    if (isCompressed) {
      const uncompressedSize = (chunkData[0] << 24) | (chunkData[1] << 16) |
                               (chunkData[2] << 8) | chunkData[3];
      const compressedData = chunkData.subarray(4);
      chunkData = lz4Decompress(compressedData, uncompressedSize);
    }

    // Decode based on chunk type
    if (chunk.type === QOV_CHUNK_KEYFRAME) {
      if (isYuvChunk || this.isYuvMode) {
        this.decodeYuvKeyframeFromData(chunkData);
      } else {
        this.decodeRgbKeyframeFromData(chunkData);
      }
    } else if (chunk.type === QOV_CHUNK_PFRAME) {
      if (isYuvChunk || this.isYuvMode) {
        this.decodeYuvPFrameFromData(chunkData);
      } else {
        this.decodeRgbPFrameFromData(chunkData, (chunk.flags & 0x02) !== 0);
      }
    }

    this.lastDecodedFrameIndex = frameIndex;
  }

  // Simplified read from activeData
  private readU8(): number {
    return this.activeData![this.activePos++];
  }

  private readU16(): number {
    return (this.readU8() << 8) | this.readU8();
  }

  private colorHash(c: QovRGBA): number {
    return (c.r * 3 + c.g * 5 + c.b * 7 + c.a * 11) % 64;
  }

  // RGB keyframe decoding
  private decodeRgbKeyframeFromData(data: Uint8Array): void {
    this.activeData = data;
    this.activePos = 0;

    const pixelCount = this.header!.width * this.header!.height;
    const dataEnd = data.length - 8; // Exclude end marker
    let px = 0;

    this.resetIndex();

    while (px < pixelCount && this.activePos < dataEnd) {
      const b1 = this.readU8();

      if (b1 === 0xfe) {
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
      } else if (b1 === 0xff) {
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
        this.prevPixel.a = this.readU8();
      } else if ((b1 & 0xc0) === 0x00) {
        const idx = b1 & 0x3f;
        this.prevPixel = { ...this.index[idx] };
      } else if ((b1 & 0xc0) === 0x40) {
        this.prevPixel.r = (this.prevPixel.r + ((b1 >> 4) & 0x03) - 2) & 0xff;
        this.prevPixel.g = (this.prevPixel.g + ((b1 >> 2) & 0x03) - 2) & 0xff;
        this.prevPixel.b = (this.prevPixel.b + (b1 & 0x03) - 2) & 0xff;
      } else if ((b1 & 0xc0) === 0x80) {
        const b2 = this.readU8();
        const dg = (b1 & 0x3f) - 32;
        const dr_dg = ((b2 >> 4) & 0x0f) - 8;
        const db_dg = (b2 & 0x0f) - 8;
        this.prevPixel.r = (this.prevPixel.r + dg + dr_dg) & 0xff;
        this.prevPixel.g = (this.prevPixel.g + dg) & 0xff;
        this.prevPixel.b = (this.prevPixel.b + dg + db_dg) & 0xff;
      } else if ((b1 & 0xc0) === 0xc0) {
        const run = (b1 & 0x3f) + 1;
        for (let i = 0; i < run && px < pixelCount; i++) {
          const offset = px * 4;
          this.currFrame![offset] = this.prevPixel.r;
          this.currFrame![offset + 1] = this.prevPixel.g;
          this.currFrame![offset + 2] = this.prevPixel.b;
          this.currFrame![offset + 3] = this.prevPixel.a;
          px++;
        }
        continue;
      }

      this.index[this.colorHash(this.prevPixel)] = { ...this.prevPixel };
      const offset = px * 4;
      this.currFrame![offset] = this.prevPixel.r;
      this.currFrame![offset + 1] = this.prevPixel.g;
      this.currFrame![offset + 2] = this.prevPixel.b;
      this.currFrame![offset + 3] = this.prevPixel.a;
      px++;
    }

    // Swap buffers
    [this.prevFrame, this.currFrame] = [this.currFrame, this.prevFrame];
    this.activeData = null;
  }

  // RGB P-frame decoding
  private decodeRgbPFrameFromData(data: Uint8Array, hasMotion: boolean): void {
    this.activeData = data;
    this.activePos = 0;

    const pixelCount = this.header!.width * this.header!.height;
    const dataEnd = data.length - 8;

    // Copy previous frame as base
    if (!hasMotion) {
      this.currFrame!.set(this.prevFrame!);
    }

    let px = 0;

    while (px < pixelCount && this.activePos < dataEnd) {
      const b1 = this.readU8();

      if (b1 === 0x00) {
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        const skip = (b1 & 0x3f) + 1;
        px += skip;
      } else if ((b1 & 0xc0) === 0x40) {
        const offset = px * 4;
        this.currFrame![offset] = (this.currFrame![offset] + ((b1 >> 4) & 0x03) - 2) & 0xff;
        this.currFrame![offset + 1] = (this.currFrame![offset + 1] + ((b1 >> 2) & 0x03) - 2) & 0xff;
        this.currFrame![offset + 2] = (this.currFrame![offset + 2] + (b1 & 0x03) - 2) & 0xff;
        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 0xc0) === 0x80) {
        const b2 = this.readU8();
        const offset = px * 4;
        const dg = (b1 & 0x3f) - 32;
        const dr_dg = ((b2 >> 4) & 0x0f) - 8;
        const db_dg = (b2 & 0x0f) - 8;
        this.currFrame![offset] = (this.currFrame![offset] + dg + dr_dg) & 0xff;
        this.currFrame![offset + 1] = (this.currFrame![offset + 1] + dg) & 0xff;
        this.currFrame![offset + 2] = (this.currFrame![offset + 2] + dg + db_dg) & 0xff;
        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 0xc0) === 0x00) {
        const idx = b1 & 0x3f;
        const c = this.index[idx];
        const offset = px * 4;
        this.currFrame![offset] = c.r;
        this.currFrame![offset + 1] = c.g;
        this.currFrame![offset + 2] = c.b;
        this.currFrame![offset + 3] = c.a;
        px++;
      } else if (b1 === 0xfe) {
        const offset = px * 4;
        this.currFrame![offset] = this.readU8();
        this.currFrame![offset + 1] = this.readU8();
        this.currFrame![offset + 2] = this.readU8();
        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if (b1 === 0xff) {
        const offset = px * 4;
        this.currFrame![offset] = this.readU8();
        this.currFrame![offset + 1] = this.readU8();
        this.currFrame![offset + 2] = this.readU8();
        this.currFrame![offset + 3] = this.readU8();
        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      }
    }

    [this.prevFrame, this.currFrame] = [this.currFrame, this.prevFrame];
    this.activeData = null;
  }

  // YUV keyframe decoding
  private decodeYuvKeyframeFromData(data: Uint8Array): void {
    this.activeData = data;
    this.activePos = 0;

    const { width, height, colorspace } = this.header!;
    const ySize = width * height;

    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    this.decodeYuvPlane(this.currYPlane!, ySize, false);
    this.decodeYuvPlane(this.currUPlane!, uvSize, false);
    this.decodeYuvPlane(this.currVPlane!, uvSize, false);

    if (this.hasYuvAlpha && this.currAPlane) {
      this.decodeYuvPlane(this.currAPlane, ySize, false);
    }

    this.yuvPlanesToRgba();

    // Swap buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    [this.prevFrame, this.currFrame] = [this.currFrame, this.prevFrame];

    this.activeData = null;
  }

  // YUV P-frame decoding
  private decodeYuvPFrameFromData(data: Uint8Array): void {
    this.activeData = data;
    this.activePos = 0;

    const { width, height, colorspace } = this.header!;
    const ySize = width * height;

    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    // Copy previous planes and decode deltas
    this.currYPlane!.set(this.prevYPlane!);
    this.currUPlane!.set(this.prevUPlane!);
    this.currVPlane!.set(this.prevVPlane!);

    this.decodeYuvPlane(this.currYPlane!, ySize, true);
    this.decodeYuvPlane(this.currUPlane!, uvSize, true);
    this.decodeYuvPlane(this.currVPlane!, uvSize, true);

    if (this.hasYuvAlpha && this.currAPlane && this.prevAPlane) {
      this.currAPlane.set(this.prevAPlane);
      this.decodeYuvPlane(this.currAPlane, ySize, true);
    }

    this.yuvPlanesToRgba();

    // Swap buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    [this.prevFrame, this.currFrame] = [this.currFrame, this.prevFrame];

    this.activeData = null;
  }

  // Decode YUV plane
  private decodeYuvPlane(plane: Uint8Array, size: number, isPFrame: boolean): void {
    let prevVal = isPFrame ? 0 : 0;
    const yuvIndex: number[] = new Array(64).fill(0);
    let px = 0;

    while (px < size && this.activePos < this.activeData!.length - 8) {
      const b1 = this.readU8();

      if (b1 === 0x00 && isPFrame) {
        // SKIP_LONG for P-frames only
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // RUN (keyframe) or SKIP (P-frame)
        const count = (b1 & 0x3f) + 1;
        if (isPFrame) {
          px += count; // Skip unchanged
        } else {
          for (let i = 0; i < count && px < size; i++) {
            plane[px++] = prevVal;
          }
        }
      } else if ((b1 & 0xc0) === 0x00) {
        // INDEX - for keyframes 0x00 means INDEX[0], for P-frames 0x00 is caught above
        const idx = b1 & 0x3f;
        prevVal = yuvIndex[idx];
        plane[px++] = prevVal;
      } else if ((b1 & 0xc0) === 0x40) {
        const d = (b1 & 0x0f) - 8;
        if (isPFrame) {
          plane[px] = (plane[px] + d) & 0xff;
          prevVal = plane[px];
        } else {
          prevVal = (prevVal + d) & 0xff;
          plane[px] = prevVal;
        }
        const idx = (prevVal * 3) % 64;
        yuvIndex[idx] = prevVal;
        px++;
      } else if ((b1 & 0xc0) === 0x80) {
        const d = (b1 & 0x3f) - 32;
        if (isPFrame) {
          plane[px] = (plane[px] + d) & 0xff;
          prevVal = plane[px];
        } else {
          prevVal = (prevVal + d) & 0xff;
          plane[px] = prevVal;
        }
        const idx = (prevVal * 3) % 64;
        yuvIndex[idx] = prevVal;
        px++;
      } else if (b1 === 0xfe) {
        prevVal = this.readU8();
        const idx = (prevVal * 3) % 64;
        yuvIndex[idx] = prevVal;
        plane[px++] = prevVal;
      }
    }
  }

  // Convert YUV planes to RGBA
  private yuvPlanesToRgba(): void {
    if (!this.currYPlane || !this.currUPlane || !this.currVPlane) return;

    const { width, height, colorspace } = this.header!;
    const aPlane = this.hasYuvAlpha ? this.currAPlane : null;

    let pixels: Uint8ClampedArray;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      pixels = yuv420PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      pixels = yuv422PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    } else {
      pixels = yuv444PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    }

    this.currFrame!.set(pixels);
  }

  // Get header (must call parseHeader first)
  getHeader(): QovHeader | null {
    return this.header;
  }

  // Check if header is ready
  isHeaderReady(): boolean {
    return this.headerParsed;
  }

  // Check if index is built
  isIndexReady(): boolean {
    return this.indexBuilt;
  }

  // Get file stats
  getFileStats(): QovFileStats | null {
    if (!this.header || !this.indexBuilt) return null;

    const chunks: QovChunkInfo[] = this.chunks.map(c => ({
      type: c.type,
      typeName: getChunkTypeName(c.type),
      offset: c.offset,
      size: c.size,
      timestamp: c.timestamp,
      isKeyframe: c.type === QOV_CHUNK_KEYFRAME,
      isCompressed: (c.flags & QOV_CHUNK_FLAG_COMPRESSED) !== 0,
    }));

    const lastChunk = this.chunks[this.chunks.length - 1];
    const duration = lastChunk ? lastChunk.timestamp : 0;

    return {
      header: this.header,
      fileSize: this.source.getSize() || this.source.getLoadedSize(),
      chunks,
      keyframeIndices: [...this.keyframeIndices],
      indexTable: [],
      duration,
    };
  }
}
