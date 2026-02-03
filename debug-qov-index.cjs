// Diagnostic script to analyze QOV file for INDEX table desynchronization
const fs = require('fs');

class QOVAnalyzer {
  constructor(filePath) {
    this.data = new Uint8Array(fs.readFileSync(filePath));
    this.pos = 0;
    this.width = 0;
    this.height = 0;
    this.frameCount = 0;
    this.prevY = null;
    this.prevU = null;
    this.prevV = null;
  }

  readU8() {
    return this.data[this.pos++];
  }

  readU16() {
    const lo = this.readU8();
    const hi = this.readU8();
    return (hi << 8) | lo;
  }

  readU32() {
    const b0 = this.readU8();
    const b1 = this.readU8();
    const b2 = this.readU8();
    const b3 = this.readU8();
    return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
  }

  analyze(maxFrames = 20) {
    const results = [];

    // Read header
    const magic = String.fromCharCode(this.readU8(), this.readU8(), this.readU8(), this.readU8());
    if (magic !== 'qovf') {
      throw new Error(`Invalid QOV file, got magic: ${magic}`);
    }

    const version = this.readU8();
    this.width = this.readU16();
    this.height = this.readU16();
    const fps = this.readU8();
    this.frameCount = this.readU32();

    console.log(`QOV File: ${this.width}x${this.height}, ${fps}fps, ${this.frameCount} frames`);
    console.log('=====================================\n');

    // Analyze frames
    for (let f = 0; f < Math.min(this.frameCount, maxFrames); f++) {
      const frameType = this.readU8();
      const isKeyframe = frameType === 0x01;

      const analysis = {
        frameNumber: f,
        frameType: isKeyframe ? 'I-frame' : 'P-frame',
        indexErrors: [],
        indexTableSnapshot: {
          Y: new Array(64).fill(-1),
          U: new Array(64).fill(-1),
          V: new Array(64).fill(-1)
        }
      };

      console.log(`\n--- Frame ${f} (${analysis.frameType}) ---`);

      if (isKeyframe) {
        // I-frame
        const ySize = this.readU32();
        const uSize = this.readU32();
        const vSize = this.readU32();

        const yPlane = new Uint8Array(this.width * this.height);
        const uPlane = new Uint8Array((this.width / 2) * (this.height / 2));
        const vPlane = new Uint8Array((this.width / 2) * (this.height / 2));

        this.decodeYuvPlaneKeyframe(yPlane, analysis.indexTableSnapshot.Y, yPlane.length);
        this.decodeYuvPlaneKeyframe(uPlane, analysis.indexTableSnapshot.U, uPlane.length);
        this.decodeYuvPlaneKeyframe(vPlane, analysis.indexTableSnapshot.V, vPlane.length);

        this.prevY = yPlane;
        this.prevU = uPlane;
        this.prevV = vPlane;

        console.log(`  I-frame decoded successfully`);
      } else {
        // P-frame
        const ySize = this.readU32();
        const uSize = this.readU32();
        const vSize = this.readU32();

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

      results.push(analysis);
    }

    return results;
  }

  decodeYuvPlaneKeyframe(plane, index, size) {
    let px = 0;
    let prevVal = 128;

    while (px < size) {
      const b1 = this.readU8();

      if (b1 === 0x00) {
        // RUN0
        const count = this.readU16();
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

      if (b1 === 0x00) {
        // SKIP_LONG
        const skip = this.readU16();
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
  if (result.indexErrors.length > 0) {
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
console.log(`First error at frame: ${firstErrorFrame}`);
console.log(`Total INDEX errors: ${totalErrors}`);

if (errorsByFrame.length > 0) {
  console.log(`\nFrames with errors: ${errorsByFrame.join(', ')}`);

  // Check for patterns
  const errorPattern = errorsByFrame.slice(1).map((f, i) => f - errorsByFrame[i]);
  console.log(`Error frame gaps: ${errorPattern.join(', ')}`);
}
