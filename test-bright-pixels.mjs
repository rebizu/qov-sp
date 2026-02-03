// Test for overflow/wraparound with very bright pixels

// BT.601 coefficients
const KR = 0.299;
const KG = 0.587;
const KB = 0.114;

function rgbToYuv(r, g, b) {
  const y = Math.round(KR * r + KG * g + KB * b);
  const u = Math.round(-0.169 * r - 0.331 * g + 0.500 * b + 128);
  const v = Math.round(0.500 * r - 0.419 * g - 0.081 * b + 128);

  console.log(`  Before clamp: Y=${y}, U=${u}, V=${v}`);

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

  console.log(`  Before clamp: R=${r}, G=${g}, B=${b}`);

  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b)),
  };
}

console.log('Testing Bright Pixel Overflow/Wraparound\n');
console.log('=' .repeat(70));

// Test extreme bright colors
const brightTests = [
  { r: 255, g: 255, b: 255, name: 'Pure White' },
  { r: 255, g: 0, b: 0, name: 'Pure Red' },
  { r: 0, g: 255, b: 0, name: 'Pure Green' },
  { r: 0, g: 0, b: 255, name: 'Pure Blue' },
  { r: 255, g: 255, b: 0, name: 'Yellow' },
  { r: 255, g: 0, b: 255, name: 'Magenta' },
  { r: 0, g: 255, b: 255, name: 'Cyan' },
];

let hadOverflow = false;

for (const test of brightTests) {
  const { r, g, b, name } = test;

  console.log(`\n${name}: RGB(${r}, ${g}, ${b})`);

  // Convert RGB -> YUV
  const yuv = rgbToYuv(r, g, b);
  console.log(`  After clamp:  Y=${yuv.y}, U=${yuv.u}, V=${yuv.v}`);

  // Check if any clamping occurred
  const yRaw = Math.round(KR * r + KG * g + KB * b);
  const uRaw = Math.round(-0.169 * r - 0.331 * g + 0.500 * b + 128);
  const vRaw = Math.round(0.500 * r - 0.419 * g - 0.081 * b + 128);

  if (yRaw > 255 || yRaw < 0 || uRaw > 255 || uRaw < 0 || vRaw > 255 || vRaw < 0) {
    console.log(`  ⚠️  OVERFLOW DETECTED! Clamping applied.`);
    hadOverflow = true;
  }

  // Convert YUV -> RGB
  console.log(`\n  YUV -> RGB conversion:`);
  const rgb2 = yuvToRgb(yuv.y, yuv.u, yuv.v);
  console.log(`  After clamp:  R=${rgb2.r}, G=${rgb2.g}, B=${rgb2.b}`);

  // Calculate error
  const dr = Math.abs(r - rgb2.r);
  const dg = Math.abs(g - rgb2.g);
  const db = Math.abs(b - rgb2.b);
  const maxError = Math.max(dr, dg, db);

  console.log(`\n  Round-trip error: R=${dr}, G=${dg}, B=${db} (max=${maxError})`);

  if (maxError > 2) {
    console.log(`  ⚠️  SIGNIFICANT ERROR (>${maxError})`);
  }
}

console.log('\n' + '='.repeat(70));
console.log(`\nSummary: ${hadOverflow ? '⚠️  Overflow/clamping occurred' : '✓ No overflow detected'}`);

// Test edge cases near boundaries
console.log('\n\n' + '='.repeat(70));
console.log('Testing Boundary Cases (very bright with extreme chroma)\n');

const boundaryTests = [
  { y: 255, u: 0, v: 0, desc: 'Max Y, Min UV' },
  { y: 255, u: 255, v: 255, desc: 'Max Y, Max UV' },
  { y: 255, u: 0, v: 255, desc: 'Max Y, Min U, Max V' },
  { y: 255, u: 255, v: 0, desc: 'Max Y, Max U, Min V' },
];

for (const test of boundaryTests) {
  const { y, u, v, desc } = test;

  console.log(`\n${desc}: YUV(${y}, ${u}, ${v})`);
  const rgb = yuvToRgb(y, u, v);
  console.log(`  Result: RGB(${rgb.r}, ${rgb.g}, ${rgb.b})`);

  // Check for extreme values that might indicate issues
  if (rgb.r === 255 && rgb.g === 255 && rgb.b === 255) {
    console.log(`  → Pure white (expected for some cases)`);
  } else if (rgb.r === 0 || rgb.g === 0 || rgb.b === 0) {
    console.log(`  → Contains black channel (check if expected)`);
  }
}

console.log('\n' + '='.repeat(70));
