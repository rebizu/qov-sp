// LZ4 Block Compression - Optimized for fast decompression
// Based on LZ4 block format specification: https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md

/**
 * LZ4 compress a block of data.
 * Returns compressed data or null if compression would not reduce size.
 */
export function lz4Compress(input: Uint8Array): Uint8Array | null {
  const inputSize = input.length;
  if (inputSize === 0) {
    return new Uint8Array(0);
  }

  // Worst case output size: input + (input / 255) + 16
  const maxOutputSize = inputSize + Math.ceil(inputSize / 255) + 16;
  const output = new Uint8Array(maxOutputSize);
  let outPos = 0;

  // Hash table for finding matches (4-byte sequences)
  // Size must be power of 2, use 64KB table
  const HASH_SIZE = 1 << 16;
  const hashTable = new Int32Array(HASH_SIZE);
  hashTable.fill(-1);

  const MIN_MATCH = 4;
  const LAST_LITERALS = 5; // Must leave 5 bytes at end for safety

  let anchor = 0; // Start of current literal run
  let pos = 0;

  // Main compression loop
  while (pos < inputSize - LAST_LITERALS) {
    // Calculate hash of next 4 bytes
    const h = hash4(input, pos);
    const ref = hashTable[h];
    hashTable[h] = pos;

    // Check for match
    if (ref >= 0 && pos - ref < 65535 && match4(input, pos, ref)) {
      // Found a match! First, emit any pending literals
      const literalLen = pos - anchor;

      // Extend match backwards (optional optimization)
      // Extend match forwards
      let matchLen = 4;
      while (pos + matchLen < inputSize - LAST_LITERALS &&
             input[ref + matchLen] === input[pos + matchLen]) {
        matchLen++;
      }

      // Write token
      const tokenPos = outPos++;
      let token = 0;

      // Encode literal length
      if (literalLen >= 15) {
        token = 15 << 4;
        let remaining = literalLen - 15;
        while (remaining >= 255) {
          output[outPos++] = 255;
          remaining -= 255;
        }
        output[outPos++] = remaining;
      } else {
        token = literalLen << 4;
      }

      // Copy literals
      for (let i = 0; i < literalLen; i++) {
        output[outPos++] = input[anchor + i];
      }

      // Write offset (little-endian)
      const offset = pos - ref;
      output[outPos++] = offset & 0xff;
      output[outPos++] = (offset >> 8) & 0xff;

      // Encode match length
      const matchLenMinus4 = matchLen - MIN_MATCH;
      if (matchLenMinus4 >= 15) {
        token |= 15;
        let remaining = matchLenMinus4 - 15;
        while (remaining >= 255) {
          output[outPos++] = 255;
          remaining -= 255;
        }
        output[outPos++] = remaining;
      } else {
        token |= matchLenMinus4;
      }

      output[tokenPos] = token;

      // Update position and anchor
      pos += matchLen;
      anchor = pos;

      // Insert hashes for skipped positions (improves ratio)
      if (pos < inputSize - LAST_LITERALS) {
        hashTable[hash4(input, pos - 2)] = pos - 2;
      }
    } else {
      pos++;
    }
  }

  // Emit remaining literals (last bytes)
  const lastLiterals = inputSize - anchor;
  if (lastLiterals > 0) {
    // Write token
    if (lastLiterals >= 15) {
      output[outPos++] = 15 << 4;
      let remaining = lastLiterals - 15;
      while (remaining >= 255) {
        output[outPos++] = 255;
        remaining -= 255;
      }
      output[outPos++] = remaining;
    } else {
      output[outPos++] = lastLiterals << 4;
    }

    // Copy literals
    for (let i = 0; i < lastLiterals; i++) {
      output[outPos++] = input[anchor + i];
    }
  }

  // Check if compression was worthwhile (at least 5% reduction)
  if (outPos >= inputSize * 0.95) {
    return null; // Not worth compressing
  }

  return output.subarray(0, outPos);
}

/**
 * LZ4 decompress a block of data.
 * outputSize must be known in advance (stored in chunk header).
 */
export function lz4Decompress(input: Uint8Array, outputSize: number): Uint8Array {
  if (input.length === 0) {
    return new Uint8Array(0);
  }

  const output = new Uint8Array(outputSize);
  let inPos = 0;
  let outPos = 0;

  while (inPos < input.length) {
    // Read token
    const token = input[inPos++];
    const literalLen = token >> 4;
    const matchLen = token & 0x0f;

    // Decode literal length
    let litLen = literalLen;
    if (literalLen === 15) {
      let b;
      do {
        b = input[inPos++];
        litLen += b;
      } while (b === 255);
    }

    // Copy literals
    for (let i = 0; i < litLen; i++) {
      output[outPos++] = input[inPos++];
    }

    // Check if we've reached the end (no match after last literals)
    if (inPos >= input.length) {
      break;
    }

    // Read offset (little-endian)
    const offset = input[inPos++] | (input[inPos++] << 8);

    // Decode match length
    let mLen = matchLen + 4; // Minimum match is 4
    if (matchLen === 15) {
      let b;
      do {
        b = input[inPos++];
        mLen += b;
      } while (b === 255);
    }

    // Copy match (may overlap with output)
    const matchPos = outPos - offset;
    for (let i = 0; i < mLen; i++) {
      output[outPos++] = output[matchPos + i];
    }
  }

  return output;
}

// Hash function for 4-byte sequences
function hash4(data: Uint8Array, pos: number): number {
  // Simple multiplicative hash
  const v = (data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24)) >>> 0;
  return (v * 2654435769 >>> 16) & 0xffff;
}

// Check if 4 bytes match
function match4(data: Uint8Array, pos1: number, pos2: number): boolean {
  return data[pos1] === data[pos2] &&
         data[pos1 + 1] === data[pos2 + 1] &&
         data[pos1 + 2] === data[pos2 + 2] &&
         data[pos1 + 3] === data[pos2 + 3];
}
