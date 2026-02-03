// Simple QOV analyzer - just find frames and decode them
const fs = require('fs');

const data = new Uint8Array(fs.readFileSync('/mnt/c/Users/RenéBrokholm/Downloads/recording-1770105419062.qov'));
let pos = 0;

function readU8() { return data[pos++]; }
function readU16BE() { const hi = readU8(); const lo = readU8(); return (hi << 8) | lo; }
function readU32BE() { return (readU8() << 24) | (readU8() << 16) | (readU8() << 8) | readU8(); }

// Skip file header (24 bytes)
pos = 24;

console.log('Scanning for frame chunks...\n');

let prevY = null, prevU = null, prevV = null;
let frameNum = 0;

while (pos < data.length && frameNum < 20) {
  const chunkStart = pos;
  const chunkType = readU8();
  const chunkFlags = readU8();
  const chunkSize = readU32BE();
  const timestamp = readU32BE();

  console.log(`\nOffset ${chunkStart}: type=0x${chunkType.toString(16).padStart(2,'0')}, flags=0x${chunkFlags.toString(16).padStart(2,'0')}, size=${chunkSize}, ts=${timestamp}`);

  if (chunkType === 0x01 || chunkType === 0x02) {
    const isKeyframe = chunkType === 0x01;
    const isYUV = (chunkFlags & 0x01) !== 0;

    console.log(`  => ${isKeyframe ? 'I-frame' : 'P-frame'} ${isYUV ? '(YUV)' : '(RGB)'}`);

    if (isYUV) {
      // Try to decode YUV planes
      const width = 640, height = 480;
      const ySize = width * height;
      const uSize = (width / 2) * (height / 2);
      const vSize = uSize;

      const yPlane = new Uint8Array(ySize);
      const uPlane = new Uint8Array(uSize);
      const vPlane = new Uint8Array(vSize);

      if (isKeyframe) {
        // I-frame
        prevY = yPlane;
        prevU = uPlane;
        prevV = vPlane;

        console.log(`  Decoding I-frame planes...`);
        const yIndex = new Array(64).fill(-1);
        const uIndex = new Array(64).fill(-1);
        const vIndex = new Array(64).fill(-1);

        decodeKeyframePlane(yPlane, yIndex);
        decodeKeyframePlane(uPlane, uIndex);
        decodeKeyframePlane(vPlane, vIndex);

        console.log(`  ✓ I-frame decoded`);
      } else {
        // P-frame
        if (!prevY) {
          console.log(`  ERROR: P-frame without previous frame!`);
        } else {
          yPlane.set(prevY);
          uPlane.set(prevU);
          vPlane.set(prevV);

          const yIndex = new Array(64).fill(-1);
          const uIndex = new Array(64).fill(-1);
          const vIndex = new Array(64).fill(-1);

          const yErrors = [];
          const uErrors = [];
          const vErrors = [];

          console.log(`  Decoding P-frame planes...`);
          decodePFramePlane(yPlane, prevY, yIndex, yErrors);
          decodePFramePlane(uPlane, prevU, uIndex, uErrors);
          decodePFramePlane(vPlane, prevV, vIndex, vErrors);

          const totalErrors = yErrors.length + uErrors.length + vErrors.length;
          if (totalErrors > 0) {
            console.log(`  ⚠️  P-frame has ${totalErrors} INDEX errors!`);
            if (yErrors.length > 0) console.log(`    Y: ${yErrors.length} errors, slots: [${[...new Set(yErrors)].sort((a,b)=>a-b).join(', ')}]`);
            if (uErrors.length > 0) console.log(`    U: ${uErrors.length} errors, slots: [${[...new Set(uErrors)].sort((a,b)=>a-b).join(', ')}]`);
            if (vErrors.length > 0) console.log(`    V: ${vErrors.length} errors, slots: [${[...new Set(vErrors)].sort((a,b)=>a-b).join(', ')}]`);
          } else {
            console.log(`  ✓ P-frame decoded without errors`);
          }

          prevY = yPlane;
          prevU = uPlane;
          prevV = vPlane;
        }
      }
      frameNum++;
    }
  }

  // Skip to next chunk
  pos = chunkStart + 10 + chunkSize;
}

function decodeKeyframePlane(plane, index) {
  let px = 0;
  let prevVal = 128;
  const size = plane.length;

  while (px < size) {
    if (pos >= data.length) break;

    const b1 = readU8();

    // Check for end marker
    if (b1 === 0x00 && pos + 6 < data.length &&
        data[pos] === 0x00 && data[pos+1] === 0x00 && data[pos+2] === 0x00 &&
        data[pos+3] === 0x00 && data[pos+4] === 0x00 && data[pos+5] === 0x00 && data[pos+6] === 0x01) {
      pos += 7;
      break;
    }

    if (b1 === 0x00) {
      const count = readU16BE();
      for (let i = 0; i < count && px < size; i++) plane[px++] = prevVal;
    } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
      const count = (b1 & 0x3f) + 1;
      for (let i = 0; i < count && px < size; i++) plane[px++] = prevVal;
    } else if ((b1 & 0xc0) === 0x00) {
      const idx = b1 & 0x3f;
      const val = index[idx];
      plane[px++] = val;
      prevVal = val;
    } else if ((b1 & 0xc0) === 0x40) {
      const d = (b1 & 0x3f) - 32;
      const val = (prevVal + d) & 0xff;
      plane[px++] = val;
      index[(val * 3) % 64] = val;
      prevVal = val;
    } else if ((b1 & 0xc0) === 0x80) {
      const val = ((b1 & 0x3f) << 2) | (readU8() & 0x03);
      plane[px++] = val;
      index[(val * 3) % 64] = val;
      prevVal = val;
    } else if (b1 === 0xfe) {
      const val = readU8();
      plane[px++] = val;
      index[(val * 3) % 64] = val;
      prevVal = val;
    }
  }
}

function decodePFramePlane(plane, prevPlane, index, errors) {
  let px = 0;
  const size = plane.length;

  while (px < size) {
    if (pos >= data.length) break;

    const b1 = readU8();

    // Check for end marker
    if (b1 === 0x00 && pos + 6 < data.length &&
        data[pos] === 0x00 && data[pos+1] === 0x00 && data[pos+2] === 0x00 &&
        data[pos+3] === 0x00 && data[pos+4] === 0x00 && data[pos+5] === 0x00 && data[pos+6] === 0x01) {
      pos += 7;
      break;
    }

    if (b1 === 0x00) {
      const skip = readU16BE();
      px += skip;
    } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
      const skip = (b1 & 0x3f) + 1;
      px += skip;
    } else if ((b1 & 0xc0) === 0x00) {
      const idx = b1 & 0x3f;
      if (index[idx] === -1) {
        errors.push(idx);
        plane[px++] = 128;
      } else {
        plane[px++] = index[idx];
      }
    } else if ((b1 & 0xc0) === 0x40) {
      const d = (b1 & 0x0f) - 8;
      plane[px] = (prevPlane[px] + d) & 0xff;
      index[(plane[px] * 3) % 64] = plane[px];
      px++;
    } else if ((b1 & 0xc0) === 0x80) {
      const d = (b1 & 0x3f) - 32;
      plane[px] = (prevPlane[px] + d) & 0xff;
      index[(plane[px] * 3) % 64] = plane[px];
      px++;
    } else if (b1 === 0xfe) {
      const val = readU8();
      plane[px++] = val;
      index[(val * 3) % 64] = val;
    }
  }
}
