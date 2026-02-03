// Test YUV round-trip conversion accuracy
import { rgbToYuv, yuvToRgb } from './dist/color-utils.js';

console.log('Testing YUV Round-Trip Conversion\n');

// Test cases: RGB values that should round-trip correctly
const testCases = [
  { r: 0, g: 0, b: 0, name: 'Black' },
  { r: 255, g: 255, b: 255, name: 'White' },
  { r: 255, g: 0, b: 0, name: 'Red' },
  { r: 0, g: 255, b: 0, name: 'Green' },
  { r: 0, g: 0, b: 255, name: 'Blue' },
  { r: 128, g: 128, b: 128, name: 'Gray' },
  { r: 16, g: 16, b: 16, name: 'Near Black' },
  { r: 10, g: 10, b: 10, name: 'Very Dark' },
  { r: 240, g: 240, b: 240, name: 'Near White' },
  { r: 200, g: 50, b: 100, name: 'Random 1' },
  { r: 50, g: 200, b: 150, name: 'Random 2' },
];

let maxError = 0;
let totalError = 0;
let problemCases = [];

for (const test of testCases) {
  const { r, g, b, name } = test;

  // Convert RGB -> YUV -> RGB
  const yuv = rgbToYuv(r, g, b);
  const rgb2 = yuvToRgb(yuv.y, yuv.u, yuv.v);

  // Calculate error
  const dr = Math.abs(r - rgb2.r);
  const dg = Math.abs(g - rgb2.g);
  const db = Math.abs(b - rgb2.b);
  const error = Math.max(dr, dg, db);
  const avgError = (dr + dg + db) / 3;

  maxError = Math.max(maxError, error);
  totalError += avgError;

  console.log(`${name.padEnd(15)} RGB(${r.toString().padStart(3)},${g.toString().padStart(3)},${b.toString().padStart(3)}) -> YUV(${yuv.y.toString().padStart(3)},${yuv.u.toString().padStart(3)},${yuv.v.toString().padStart(3)}) -> RGB(${rgb2.r.toString().padStart(3)},${rgb2.g.toString().padStart(3)},${rgb2.b.toString().padStart(3)}) | Error: ${error} (avg: ${avgError.toFixed(1)})`);

  if (error > 2) {
    problemCases.push({ name, original: {r, g, b}, yuv, decoded: rgb2, error });
  }
}

console.log(`\n=== Summary ===`);
console.log(`Max error: ${maxError}`);
console.log(`Avg error: ${(totalError / testCases.length).toFixed(2)}`);
console.log(`Problem cases (error > 2): ${problemCases.length}`);

if (problemCases.length > 0) {
  console.log('\n=== Problem Cases ===');
  for (const p of problemCases) {
    console.log(`${p.name}: RGB(${p.original.r},${p.original.g},${p.original.b}) -> RGB(${p.decoded.r},${p.decoded.g},${p.decoded.b}) | Error: ${p.error}`);
  }
}

// Test edge cases that might produce black
console.log('\n=== Testing Edge Cases ===');
const edgeCases = [
  { y: 0, u: 128, v: 128 },
  { y: 16, u: 128, v: 128 },
  { y: 7, u: 128, v: 128 },
  { y: 10, u: 120, v: 135 },
];

for (const yuv of edgeCases) {
  const rgb = yuvToRgb(yuv.y, yuv.u, yuv.v);
  console.log(`YUV(${yuv.y.toString().padStart(3)},${yuv.u.toString().padStart(3)},${yuv.v.toString().padStart(3)}) -> RGB(${rgb.r.toString().padStart(3)},${rgb.g.toString().padStart(3)},${rgb.b.toString().padStart(3)})`);
}
