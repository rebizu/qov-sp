#!/usr/bin/env node
// Test YUV P-frame black pixel fix

import { readFileSync } from 'fs';
import { QovDecoder } from './src/qov-decoder.js';

const filePath = '/mnt/c/Users/RenéBrokholm/Downloads/recording-1770105145026.qov';

console.log('Testing YUV P-frame decoder fix...\n');
console.log(`File: ${filePath}\n`);

try {
  const data = new Uint8Array(readFileSync(filePath));
  const decoder = new QovDecoder(data);
  const header = decoder.decodeHeader();

  console.log('Header Info:');
  console.log(`  Colorspace: 0x${header.colorspace.toString(16).padStart(2, '0')}`);
  console.log(`  Resolution: ${header.width}x${header.height}`);
  console.log(`  Total Frames: ${header.totalFrames}`);
  console.log('');

  let frameNum = 0;
  const maxFrames = 10; // Test first 10 frames

  for (const frame of decoder.decodeFrames()) {
    const totalPixels = header.width * header.height;
    let blackPixels = 0;
    let darkPixels = 0;

    for (let i = 0; i < frame.pixels.length; i += 4) {
      const r = frame.pixels[i];
      const g = frame.pixels[i + 1];
      const b = frame.pixels[i + 2];

      if (r === 0 && g === 0 && b === 0) {
        blackPixels++;
      } else if (r < 20 && g < 20 && b < 20) {
        darkPixels++;
      }
    }

    const blackPercent = (blackPixels / totalPixels * 100).toFixed(4);
    const darkPercent = (darkPixels / totalPixels * 100).toFixed(4);
    const frameType = frame.isKeyframe ? 'KEYFRAME' : 'P-FRAME ';

    console.log(`Frame ${frameNum.toString().padStart(2)}: ${frameType} | Black: ${blackPixels.toString().padStart(5)} (${blackPercent.padStart(8)}%) | Dark: ${darkPixels.toString().padStart(5)} (${darkPercent.padStart(8)}%)`);

    if (blackPixels > 0) {
      console.log(`  ⚠️  BLACK PIXELS DETECTED IN ${frame.isKeyframe ? 'KEYFRAME' : 'P-FRAME'}!`);
    }

    frameNum++;
    if (frameNum >= maxFrames) break;
  }

  console.log('\n✅ Test complete!');
  console.log('If you see "BLACK PIXELS DETECTED" in P-frames, the bug still exists.');
  console.log('If no black pixels in P-frames, the fix worked!');

} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
