// Real desynchronization scenario with hash collision

console.log('=== Real Desync Scenario with Hash Collision ===\n');
console.log('Values 64 and 128 both map to idx=0\n');

const plane = [64, 70, 64, 128];  // Note: 64 appears twice, then 128 (collision)
const prevPlane = [10, 10, 10, 10];

console.log('--- TYPESCRIPT ENCODER ---\n');
const tsEncoderIndex = new Array(64).fill(-1);

for (let i = 0; i < plane.length; i++) {
  const val = plane[i];
  const refVal = prevPlane[i];
  const d = val - refVal;
  const idx = (val * 3) % 64;

  console.log(`Pixel ${i}: val=${val}, idx=${idx}, diff=${d}`);
  console.log(`  BEFORE: index[${idx}] = ${tsEncoderIndex[idx]}`);

  if (d >= -32 && d <= 31) {
    console.log(`  Action: Emit TLUMA(${d})`);
    tsEncoderIndex[idx] = val;
  } else {
    if (tsEncoderIndex[idx] === val) {
      console.log(`  Action: Emit INDEX(${idx})`);
    } else {
      console.log(`  Action: Emit FULL(${val})`);
    }
    tsEncoderIndex[idx] = val;  // TS: Always updates!
  }
  console.log(`  AFTER:  index[${idx}] = ${tsEncoderIndex[idx]}\n`);
}

console.log('\n--- TYPESCRIPT DECODER ---\n');
const tsDecoderIndex = new Array(64).fill(-1);

// Pixel 0: FULL val=64, idx=0
console.log(`Pixel 0: FULL(64), idx=0`);
console.log(`  BEFORE: index[0] = ${tsDecoderIndex[0]}`);
tsDecoderIndex[0] = 64;
console.log(`  AFTER:  index[0] = ${tsDecoderIndex[0]}\n`);

// Pixel 1: FULL val=70, idx=18
console.log(`Pixel 1: FULL(70), idx=18`);
console.log(`  BEFORE: index[18] = ${tsDecoderIndex[18]}`);
tsDecoderIndex[18] = 70;
console.log(`  AFTER:  index[18] = ${tsDecoderIndex[18]}\n`);

// Pixel 2: INDEX(0) - expects val=64
console.log(`Pixel 2: INDEX(0)`);
console.log(`  BEFORE: index[0] = ${tsDecoderIndex[0]}`);
console.log(`  Decoded value: ${tsDecoderIndex[0]}`);
// TS Decoder does NOT update!
console.log(`  AFTER:  index[0] = ${tsDecoderIndex[0]} (NO UPDATE)\n`);

// Pixel 3: FULL val=128, idx=0 (collision!)
console.log(`Pixel 3: FULL(128), idx=0 (COLLISION!)`);
console.log(`  BEFORE: index[0] = ${tsDecoderIndex[0]}`);
tsDecoderIndex[0] = 128;
console.log(`  AFTER:  index[0] = ${tsDecoderIndex[0]}\n`);

console.log('\n=== INDEX TABLE STATE ===');
console.log(`TS Encoder index[0]: ${tsEncoderIndex[0]}`);
console.log(`TS Decoder index[0]: ${tsDecoderIndex[0]}`);

if (tsEncoderIndex[0] === tsDecoderIndex[0]) {
  console.log(`✓ IN SYNC (same value)\n`);
} else {
  console.log(`❌ OUT OF SYNC!\n`);
}

console.log('\n--- NOW SIMULATE NEXT P-FRAME ---');
console.log('Suppose next frame has pixel with val=64 and large diff\n');

console.log('TS ENCODER:');
const testIdx = (64 * 3) % 64;
console.log(`  Check: index[${testIdx}] === 64?`);
console.log(`  index[${testIdx}] = ${tsEncoderIndex[testIdx]}`);
if (tsEncoderIndex[testIdx] === 64) {
  console.log(`  => Would emit INDEX(${testIdx})`);
} else {
  console.log(`  => Would emit FULL(64)`);
}

console.log('\nTS DECODER:');
console.log(`  If INDEX(${testIdx}) received:`);
console.log(`  index[${testIdx}] = ${tsDecoderIndex[testIdx]}`);
if (tsDecoderIndex[testIdx] === -1) {
  console.log(`  ❌ ERROR: Uninitialized slot!`);
  console.log(`  Would decode as 128 instead of 64!`);
} else if (tsDecoderIndex[testIdx] !== 64) {
  console.log(`  ❌ ERROR: Wrong value!`);
  console.log(`  Would decode as ${tsDecoderIndex[testIdx]} instead of 64!`);
} else {
  console.log(`  ✓ Would decode correctly as 64`);
}

console.log('\n\n=== C# ENCODER (for comparison) ---\n');
const csEncoderIndex = new Array(64).fill(-1);

for (let i = 0; i < plane.length; i++) {
  const val = plane[i];
  const refVal = prevPlane[i];
  const d = val - refVal;
  const idx = (val * 3) % 64;

  console.log(`Pixel ${i}: val=${val}, idx=${idx}`);
  console.log(`  BEFORE: index[${idx}] = ${csEncoderIndex[idx]}`);

  if (d >= -32 && d <= 31) {
    console.log(`  Action: Emit TLUMA`);
    csEncoderIndex[idx] = val;
  } else {
    if (csEncoderIndex[idx] === val) {
      console.log(`  Action: Emit INDEX(${idx})`);
      // C#: Does NOT update!
    } else {
      console.log(`  Action: Emit FULL(${val})`);
      csEncoderIndex[idx] = val;  // C#: Only updates here
    }
  }
  console.log(`  AFTER:  index[${idx}] = ${csEncoderIndex[idx]}\n`);
}

console.log('\n=== COMPARISON ===');
console.log(`C# Encoder index[0]: ${csEncoderIndex[0]}`);
console.log(`TS Decoder index[0]: ${tsDecoderIndex[0]}`);
if (csEncoderIndex[0] === tsDecoderIndex[0]) {
  console.log(`✓ IN SYNC\n`);
}

console.log('\n=== ROOT CAUSE ===');
console.log('TypeScript encoder line 504 updates index unconditionally:');
console.log('  if (index[idx] === val) {');
console.log('    this.writeU8(idx);  // INDEX');
console.log('  } else {');
console.log('    this.writeU8(0xfe); // FULL');
console.log('    this.writeU8(val);');
console.log('  }');
console.log('  index[idx] = val;  // ← BUG: Updates in both cases!\n');
console.log('It SHOULD be:');
console.log('  if (index[idx] === val) {');
console.log('    this.writeU8(idx);  // INDEX (no update)');
console.log('  } else {');
console.log('    this.writeU8(0xfe); // FULL');
console.log('    this.writeU8(val);');
console.log('    index[idx] = val;  // Update only here');
console.log('  }');
