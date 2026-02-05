// Test YUV round-trip conversion accuracy - standalone version

// BT.601 coefficients
const KR = 0.299;
const KG = 0.587;
const KB = 0.114;

function rgbToYuv(r, g, b) {
  const y = Math.round(KR * r + KG * g + KB * b);
  const u = Math.round(-0.169 * r - 0.331 * g + 0.500 * b + 128);
  const v = Math.round(0.500 * r - 0.419 * g - 0.081 * b + 128);

  return {
    y: Math.max(0, Math.min(255, y)),
    u: Math.max(0, Math.min(255, u)),
    v: Math.max(0, Math.min(255, v)),
  };
}

function yuvToRgb(y, u, v) {
  const r = Math.round(y + 1.402 * (v - 128));
  const g = Math.round(y - 0.344 * (u - 128) - 0.714 * (v - 128));
  const b = Math.round(y + 1.772 * (u - 128));

  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b)),
  };
}

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
  { r: 7, g: 7, b: 7, name: 'Y=7 Gray' },
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

  console.log(`${name.padEnd(15)} RGB(${r.toString().padStart(3)},${g.toString().padStart(3)},${b.toString().padStart(3)}) -> YUV(${yuv.y.toString().padStart(3)},${yuv.u.toString().padStart(3)},${yuv.v.toString().padStart(3)}) -> RGB(${rgb2.r.toString().padStart(3)},${rgb2.g.toString().padStart(3)},${rgb2.b.toString().padStart(3)}) | Error: max=${error}, avg=${avgError.toFixed(1)}`);

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

// Test edge cases that might produce black or very dark
console.log('\n=== Testing Edge Cases (YUV values from file) ===');
const edgeCases = [
  { y: 0, u: 128, v: 128, desc: 'Pure black' },
  { y: 16, u: 128, v: 128, desc: 'Video black level' },
  { y: 7, u: 128, v: 128, desc: 'Darkest from file' },
  { y: 10, u: 120, v: 135, desc: 'Dark with chroma' },
  { y: 7, u: 110, v: 154, desc: 'Extreme dark' },
];

for (const yuv of edgeCases) {
  const rgb = yuvToRgb(yuv.y, yuv.u, yuv.v);
  console.log(`${yuv.desc.padEnd(25)} YUV(${yuv.y.toString().padStart(3)},${yuv.u.toString().padStart(3)},${yuv.v.toString().padStart(3)}) -> RGB(${rgb.r.toString().padStart(3)},${rgb.g.toString().padStart(3)},${rgb.b.toString().padStart(3)})`);
}

// Test if conversion is symmetric
console.log('\n=== Testing Conversion Symmetry ===');
console.log('Testing if the conversion matrices are true inverses...');

// Test neutral gray (U=V=128)
for (let y = 0; y <= 255; y += 51) {
  const rgb = yuvToRgb(y, 128, 128);
  const yuv2 = rgbToYuv(rgb.r, rgb.g, rgb.b);
  const rgb2 = yuvToRgb(yuv2.y, yuv2.u, yuv2.v);
  const error = Math.max(Math.abs(rgb.r - rgb2.r), Math.abs(rgb.g - rgb2.g), Math.abs(rgb.b - rgb2.b));
  console.log(`Y=${y.toString().padStart(3)} -> RGB(${rgb.r},${rgb.g},${rgb.b}) -> YUV(${yuv2.y},${yuv2.u},${yuv2.v}) -> RGB(${rgb2.r},${rgb2.g},${rgb2.b}) | Error: ${error}`);
}
