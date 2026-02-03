// Diagnostic script to analyze QOV v2 file for INDEX table desynchronization
const fs = require('fs');

class QOVAnalyzer {
  constructor(filePath) {
    this.data = new Uint8Array(fs.readFileSync(filePath));
    this.pos = 0;
    this.width = 0;
    this.height = 0;
    this.version = 0;
    this.prevY = null;
    this.prevU = null;
    this.prevV = null;
  }

  readU8() {
    return this.data[this.pos++];
  }

  readU16BE() {
    const hi = this.readU8();
    const lo = this.readU8();
    return (hi << 8) | lo;
  }

  readU32BE() {
    const b0 = this.readU8();
    const b1 = this.readU8();
    const b2 = this.readU8();
    const b3 = this.readU8();
    return (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
  }

  analyze(maxFrames = 20) {
    const results = [];

    // Read header
    const magic = String.fromCharCode(this.readU8(), this.readU8(), this.readU8(), this.readU8());
    if (magic !== 'qovf') {
      throw new Error(`Invalid QOV file, got magic: ${magic}`);
    }

    this.version = this.readU8();
    const flags = this.readU8();
    this.width = this.readU16BE();
    this.height = this.readU16BE();
    const fpsNum = this.readU16BE();
    const fpsDen = this.readU16BE();
    const totalFrames = this.readU32BE();
    const audioChannels = this.readU8();
    const audioRate = (this.readU8() << 16) | (this.readU8() << 8) | this.readU8();
    const colorspace = this.readU8();
    const reserved = this.readU8();

    console.log(`QOV File v${this.version}: ${this.width}x${this.height}, ${fpsNum}/${fpsDen} fps, ${totalFrames} frames`);
    console.log(`Colorspace: ${colorspace}, Audio: ${audioChannels}ch @ ${audioRate}Hz`);
    console.log('=====================================\n');

    let frameNumber = 0;

    // Read chunks
    while (this.pos < this.data.length && frameNumber < maxFrames) {
      const chunkType = this.readU8();
      const chunkFlags = this.readU8();
      const chunkSize = this.readU32BE();
      const timestamp = this.readU32BE();

      if (chunkType === 0x00) {
        // SYNC chunk
        const syncMagic = String.fromCharCode(this.readU8(), this.readU8(), this.readU8(), this.readU8());
        const syncFrameNumber = this.readU32BE();
        console.log(`\n[SYNC: frame ${syncFrameNumber}]`);
        continue;
      }

      if (chunkType === 0xFF) {
        // END chunk
        console.log('\n[END]');
        break;
      }

      if (chunkType === 0x01 || chunkType === 0x02) {
        const isKeyframe = chunkType === 0x01;
        const isYUV = (chunkFlags & 0x01) !== 0;
        const isCompressed = (chunkFlags & 0x10) !== 0;

        const analysis = {
          frameNumber: frameNumber,
          frameType: isKeyframe ? 'I-frame' : 'P-frame',
          isYUV: isYUV,
          isCompressed: isCompressed,
          indexErrors: [],
          indexTableSnapshot: {
            Y: new Array(64).fill(-1),
            U: new Array(64).fill(-1),
            V: new Array(64).fill(-1)
          }
        };

        console.log(`\n--- Frame ${frameNumber} (${analysis.frameType}, ${isYUV ? 'YUV' : 'RGB'}, ${isCompressed ? 'LZ4' : 'raw'}) ---`);

        // For now, skip compressed data - we need to implement LZ4 decompression
        if (isCompressed) {
          console.log('  [Skipping compressed frame - LZ4 decompression needed]');
          this.pos += chunkSize - 4; // Skip chunk data (minus the 4 bytes we already read for timestamp)
          frameNumber++;
          continue;
        }

        if (!isYUV) {
          console.log('  [Skipping RGB frame - only analyzing YUV frames]');
          this.pos += chunkSize - 4;
          frameNumber++;
          continue;
        }

        // Read chunk data
        const chunkDataStart = this.pos;
        const chunkDataEnd = chunkDataStart + chunkSize - 4; // -4 for timestamp already read

        if (isKeyframe) {
          // I-frame: Read plane sizes
          const yPlane = new Uint8Array(this.width * this.height);
          const uPlane = new Uint8Array((this.width / 2) * (this.height / 2));
          const vPlane = new Uint8Array((this.width / 2) * (this.height / 2));

          console.log(`  Decoding Y plane (size=${yPlane.length})...`);
          const yStart = this.pos;
          this.decodeYuvPlaneKeyframe(yPlane, analysis.indexTableSnapshot.Y, yPlane.length);
          console.log(`  Y plane decoded, consumed ${this.pos - yStart} bytes`);

          console.log(`  Decoding U plane (size=${uPlane.length})...`);
          const uStart = this.pos;
          this.decodeYuvPlaneKeyframe(uPlane, analysis.indexTableSnapshot.U, uPlane.length);
          console.log(`  U plane decoded, consumed ${this.pos - uStart} bytes`);

          console.log(`  Decoding V plane (size=${vPlane.length})...`);
          const vStart = this.pos;
          this.decodeYuvPlaneKeyframe(vPlane, analysis.indexTableSnapshot.V, vPlane.length);
          console.log(`  V plane decoded, consumed ${this.pos - vStart} bytes`);

          this.prevY = yPlane;
          this.prevU = uPlane;
          this.prevV = vPlane;

          console.log(`  I-frame decoded successfully`);
        } else {
          // P-frame
          if (!this.prevY) {
            console.log('  [ERROR: P-frame without previous frame!]');
            this.pos = chunkDataEnd;
            frameNumber++;
            continue;
          }

          const yPlane = new Uint8Array(this.width * this.height);
          const uPlane = new Uint8Array((this.width / 2) * (this.height / 2));
          const vPlane = new Uint8Array((this.width / 2) * (this.height / 2));

          yPlane.set(this.prevY);
          uPlane.set(this.prevU);
          vPlane.set(this.prevV);

          this.decodeYuvPlanePFrame(yPlane, this.prevY, analysis, 'Y', analysis.indexTableSnapshot.Y, yPlane.length);
          this.decodeYuvPlanePFrame(uPlane, this.prevU, analysis, 'U', analysis.indexTableSnapshot.U, uPlane.length);
          this.decodeYuvPlanePFrame(vPlane, this.prevV, analysis, 'V', analysis.indexTableSnapshot.V, vPlane.length);

          this.prevY = yPlane;
          this.prevU = uPlane;
          this.prevV = vPlane;

          if (analysis.indexErrors.length > 0) {
            console.log(`  ⚠️  P-frame has ${analysis.indexErrors.length} INDEX errors!`);
            for (const error of analysis.indexErrors.slice(0, 10)) {
              console.log(`    - ${error.plane} plane: INDEX(${error.indexSlot}) at pixel ${error.pixelIndex}`);
            }
            if (analysis.indexErrors.length > 10) {
              console.log(`    ... and ${analysis.indexErrors.length - 10} more errors`);
            }
          } else {
            console.log(`  ✓ P-frame decoded without INDEX errors`);
          }
        }

        // Make sure we're at the right position
        if (this.pos !== chunkDataEnd) {
          console.log(`  [WARNING: Position mismatch! Expected ${chunkDataEnd}, got ${this.pos}, diff: ${chunkDataEnd - this.pos}]`);
          this.pos = chunkDataEnd;
        }

        results.push(analysis);
        frameNumber++;
      } else {
        // Skip unknown chunk
        console.log(`\n[Skipping unknown chunk type 0x${chunkType.toString(16)}]`);
        this.pos += chunkSize - 4;
      }
    }

    return results;
  }

  decodeYuvPlaneKeyframe(plane, index, size) {
    let px = 0;
    let prevVal = 128;

    while (px < size) {
      const b1 = this.readU8();

      // Check for end marker start (0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01)
      if (b1 === 0x00 && this.pos + 6 < this.data.length) {
        const isEndMarker =
          this.data[this.pos] === 0x00 &&
          this.data[this.pos + 1] === 0x00 &&
          this.data[this.pos + 2] === 0x00 &&
          this.data[this.pos + 3] === 0x00 &&
          this.data[this.pos + 4] === 0x00 &&
          this.data[this.pos + 5] === 0x00 &&
          this.data[this.pos + 6] === 0x01;

        if (isEndMarker) {
          // Skip the rest of the end marker
          this.pos += 7;
          break;
        }

        // Not end marker, it's RUN0
        const count = this.readU16BE();
        for (let i = 0; i < count; i++) {
          plane[px++] = prevVal;
        }
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // RUN
        const count = (b1 & 0x3f) + 1;
        for (let i = 0; i < count; i++) {
          plane[px++] = prevVal;
        }
      } else if ((b1 & 0xc0) === 0x00) {
        // INDEX
        const idx = b1 & 0x3f;
        const val = index[idx];
        plane[px++] = val;
        prevVal = val;
      } else if ((b1 & 0xc0) === 0x40) {
        // DIFF
        const d = (b1 & 0x3f) - 32;
        const val = (prevVal + d) & 0xff;
        plane[px++] = val;
        const idx = (val * 3) % 64;
        index[idx] = val;
        prevVal = val;
      } else if ((b1 & 0xc0) === 0x80) {
        // LUMA
        const val = ((b1 & 0x3f) << 2) | (this.readU8() & 0x03);
        plane[px++] = val;
        const idx = (val * 3) % 64;
        index[idx] = val;
        prevVal = val;
      } else if (b1 === 0xfe) {
        // FULL
        const val = this.readU8();
        plane[px++] = val;
        const idx = (val * 3) % 64;
        index[idx] = val;
        prevVal = val;
      }
    }
  }

  decodeYuvPlanePFrame(plane, prevPlane, analysis, planeName, index, size) {
    let px = 0;

    while (px < size) {
      const b1 = this.readU8();

      // Check for end marker start (0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01)
      if (b1 === 0x00 && this.pos + 6 < this.data.length) {
        const isEndMarker =
          this.data[this.pos] === 0x00 &&
          this.data[this.pos + 1] === 0x00 &&
          this.data[this.pos + 2] === 0x00 &&
          this.data[this.pos + 3] === 0x00 &&
          this.data[this.pos + 4] === 0x00 &&
          this.data[this.pos + 5] === 0x00 &&
          this.data[this.pos + 6] === 0x01;

        if (isEndMarker) {
          // Skip the rest of the end marker
          this.pos += 7;
          break;
        }

        // Not end marker, it's SKIP_LONG
        const skip = this.readU16BE();
        px += skip;
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // SKIP
        const skip = (b1 & 0x3f) + 1;
        px += skip;
      } else if ((b1 & 0xc0) === 0x00) {
        // INDEX
        const idx = b1 & 0x3f;
        if (index[idx] === -1) {
          analysis.indexErrors.push({
            plane: planeName,
            pixelIndex: px,
            indexSlot: idx,
            totalPixelsDecoded: px
          });
          plane[px++] = 128; // Use neutral value
        } else {
          plane[px++] = index[idx];
        }
      } else if ((b1 & 0xc0) === 0x40) {
        // TDIFF
        const d = (b1 & 0x0f) - 8;
        plane[px] = (prevPlane[px] + d) & 0xff;
        const idx = (plane[px] * 3) % 64;
        index[idx] = plane[px];
        px++;
      } else if ((b1 & 0xc0) === 0x80) {
        // TLUMA-style
        const d = (b1 & 0x3f) - 32;
        plane[px] = (prevPlane[px] + d) & 0xff;
        const idx = (plane[px] * 3) % 64;
        index[idx] = plane[px];
        px++;
      } else if (b1 === 0xfe) {
        // FULL
        const val = this.readU8();
        plane[px++] = val;
        const idx = (val * 3) % 64;
        index[idx] = val;
      }
    }
  }
}

// Run analysis
const filePath = '/mnt/c/Users/RenéBrokholm/Downloads/recording-1770105419062.qov';
const analyzer = new QOVAnalyzer(filePath);
const results = analyzer.analyze(20);

console.log('\n\n=====================================');
console.log('SUMMARY REPORT');
console.log('=====================================\n');

let firstErrorFrame = -1;
let totalErrors = 0;
const errorsByFrame = [];

for (const result of results) {
  if (result.indexErrors && result.indexErrors.length > 0) {
    if (firstErrorFrame === -1) {
      firstErrorFrame = result.frameNumber;
    }
    totalErrors += result.indexErrors.length;
    errorsByFrame.push(result.frameNumber);

    console.log(`Frame ${result.frameNumber} (${result.frameType}): ${result.indexErrors.length} INDEX errors`);

    // Group errors by plane
    const yErrors = result.indexErrors.filter(e => e.plane === 'Y');
    const uErrors = result.indexErrors.filter(e => e.plane === 'U');
    const vErrors = result.indexErrors.filter(e => e.plane === 'V');

    if (yErrors.length > 0) console.log(`  Y plane: ${yErrors.length} errors`);
    if (uErrors.length > 0) console.log(`  U plane: ${uErrors.length} errors`);
    if (vErrors.length > 0) console.log(`  V plane: ${vErrors.length} errors`);

    // Show which INDEX slots are being read uninitialized
    const slots = [...new Set(result.indexErrors.map(e => e.indexSlot))].sort((a, b) => a - b);
    console.log(`  Uninitialized slots accessed: [${slots.join(', ')}]`);
  }
}

console.log(`\n${errorsByFrame.length} frames with errors out of ${results.length} analyzed`);
if (firstErrorFrame !== -1) {
  console.log(`First error at frame: ${firstErrorFrame}`);
}
console.log(`Total INDEX errors: ${totalErrors}`);

if (errorsByFrame.length > 0) {
  console.log(`\nFrames with errors: ${errorsByFrame.join(', ')}`);

  // Check for patterns
  const errorPattern = errorsByFrame.slice(1).map((f, i) => f - errorsByFrame[i]);
  console.log(`Error frame gaps: ${errorPattern.join(', ')}`);
}
