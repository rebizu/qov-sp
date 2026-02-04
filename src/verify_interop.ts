
import fs from 'fs';
import { QovDecoder } from './qov-decoder';
import { QovEncoder } from './qov-encoder';
import { QovHeader } from './qov-types';

const csFile = 'cs_lossy.qov';
const tsFile = 'ts_roundtrip_lossy.qov';

console.log(`[TS] Reading ${csFile}...`);
if (!fs.existsSync(csFile)) {
    console.error(`[TS] File ${csFile} not found!`);
    process.exit(1);
}

const data = fs.readFileSync(csFile);
const decoder = new QovDecoder(new Uint8Array(data));

// 1. Decode Header
let header: QovHeader;
try {
    header = decoder.decodeHeader();
    console.log("[TS] Header decoded successfully:");
    console.log(`     Version: 0x${header.version.toString(16)}`);
    console.log(`     Quality: ${header.quality}`);
    console.log(`     Width: ${header.width}, Height: ${header.height}`);

    if (header.version !== 0x03) {
        console.error(`[TS] ERROR: Expected version 0x03, got 0x${header.version.toString(16)}`);
        process.exit(1);
    }
    if (header.quality !== 50) {
        console.warn(`[TS] WARNING: Expected quality 50, got ${header.quality}`);
    }
} catch (e) {
    console.error("[TS] Error decoding header:", e);
    process.exit(1);
}

// 2. Decode Frames
console.log("[TS] Decoding frames...");
const frames: { pixels: Uint8ClampedArray, timestamp: number }[] = [];
try {
    for (const frame of decoder.decodeFrames()) {
        // Clone pixels because decoder reuses buffer? 
        // QovDecoder.ts: yield { pixels: new Uint8ClampedArray(this.prevFrame!), ... }
        // It creates a new array, so we are safe.
        frames.push(frame);
    }
    console.log(`[TS] Decoded ${frames.length} frames.`);
} catch (e) {
    console.error("[TS] Error decoding frames:", e);
    process.exit(1);
}

if (frames.length === 0) {
    console.error("[TS] No frames decoded!");
    process.exit(1);
}

// 3. Re-encode using TS Encoder (Round Trip)
console.log(`[TS] Re-encoding to ${tsFile}...`);
const encoder = new QovEncoder(
    header.width,
    header.height,
    header.frameRateNum,
    header.frameRateDen,
    header.flags,
    header.colorspace,
    true, // compression enabled
    header.quality // keep same quality (should trigger lossy mode)
);

encoder.writeHeader();

for (const frame of frames) {
    if (frame.isKeyframe) {
        encoder.encodeKeyframe(frame.pixels, frame.timestamp);
    } else {
        encoder.encodePFrame(frame.pixels, frame.timestamp);
    }
}

const output = encoder.finish();
fs.writeFileSync(tsFile, output);
console.log(`[TS] Wrote ${output.length} bytes to ${tsFile}`);


