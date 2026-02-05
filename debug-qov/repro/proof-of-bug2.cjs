// Better proof of INDEX table desynchronization bug with hash collision

console.log('=== INDEX Table Desynchronization Bug (with hash collision) ===\n');

// Values 0 and 64 both map to idx=0
console.log('Note: val=0 and val=64 both hash to idx=0\n');

const plane = [64, 70, 64, 0];  // Example pixel values
const prevPlane = [10, 10, 10, 10];  // Previous frame

console.log('ENCODER:\n');
const encoderIndex = new Array(64).fill(-1);

for (let i = 0; i < plane.length; i++) {
  const val = plane[i];
  const refVal = prevPlane[i];
  const d = val - refVal;
  const idx = (val * 3) % 64;

  console.log(`Pixel ${i}: val=${val}, diff=${d}, idx=${idx}`);
  console.log(`  encoderIndex[${idx}] = ${encoderIndex[idx]}`);

  if (d >= -32 && d <= 31) {
    console.log(`  => Emit TLUMA (d=${d})`);
    encoderIndex[idx] = val;
  } else {
    if (encoderIndex[idx] === val) {
      console.log(`  => Emit INDEX(${idx}) ✓`);
    } else {
      console.log(`  => Emit FULL(${val})`);
    }
    encoderIndex[idx] = val;  // ENCODER UPDATES INDEX EVEN AFTER INDEX
  }
  console.log(`  After: encoderIndex[${idx}] = ${encoderIndex[idx]}\n`);
}

console.log('\nDECODER:\n');
const decoderIndex = new Array(64).fill(-1);

// Pixel 0: TLUMA val=64
console.log(`Pixel 0: TLUMA val=64, idx=0`);
console.log(`  decoderIndex[0] = ${decoderIndex[0]}`);
decoderIndex[0] = 64;
console.log(`  After: decoderIndex[0] = ${decoderIndex[0]}\n`);

// Pixel 1: TLUMA val=70
console.log(`Pixel 1: TLUMA val=70, idx=18`);
console.log(`  decoderIndex[18] = ${decoderIndex[18]}`);
decoderIndex[18] = 70;
console.log(`  After: decoderIndex[18] = ${decoderIndex[18]}\n`);

// Pixel 2: INDEX(0) - expects val=64
console.log(`Pixel 2: INDEX(0) - expects val=64`);
console.log(`  decoderIndex[0] = ${decoderIndex[0]}`);
console.log(`  Decoded val=${decoderIndex[0]}`);
// DECODER DOES NOT UPDATE INDEX!
console.log(`  After: decoderIndex[0] = ${decoderIndex[0]} (NO UPDATE)\n`);

// Pixel 3: FULL val=0 (hash collision! also idx=0)
console.log(`Pixel 3: FULL val=0, idx=0`);
console.log(`  decoderIndex[0] = ${decoderIndex[0]}`);
decoderIndex[0] = 0;  // Overwrites!
console.log(`  After: decoderIndex[0] = ${decoderIndex[0]}\n`);

console.log('=== INDEX TABLE STATE ===');
console.log(`Encoder index[0]: ${encoderIndex[0]}`);
console.log(`Decoder index[0]: ${decoderIndex[0]}`);
console.log(`❌ DESYNC! Encoder thinks idx[0]=64, decoder has idx[0]=0\n`);

console.log('=== NEXT P-FRAME ===');
console.log('If encoder sees val=64 again with large diff:');
console.log(`  Encoder checks: encoderIndex[0] == 64? YES`);
console.log(`  => Encoder emits INDEX(0)`);
console.log(`  Decoder reads: decoderIndex[0] = ${decoderIndex[0]}`);
console.log(`  => Decoder gets val=0 instead of 64!`);
console.log(`  => VISUAL ARTIFACT: Wrong pixel value!\n`);

console.log('Actually wait, let me recheck the encoder logic...\n');

// Let me trace the exact encoder code path
console.log('=== ENCODER CODE PATH FOR PIXEL 2 ===');
console.log('val=64, refVal=10, d=54 (>31)');
console.log('idx = (64*3)%64 = 192%64 = 0');
console.log(`encoderIndex[0] = ${64} (from pixel 0)`);
console.log('Check: index[idx] === val?');
console.log(`  index[0] === 64? YES`);
console.log('  => Emit INDEX(0)');
console.log('Then: index[idx] = val');
console.log('  => index[0] = 64 (no change)\n');

console.log('=== DECODER CODE PATH FOR PIXEL 2 ===');
console.log('Reads: INDEX(0)');
console.log(`  decoderIndex[0] = ${64}`);
console.log('  => Returns value 64 ✓');
console.log('  => Does NOT update index table');
console.log(`  => decoderIndex[0] still = ${64}\n`);

console.log('=== ENCODER CODE PATH FOR PIXEL 3 ===');
console.log('val=0, refVal=10, d=-10');
console.log('idx = (0*3)%64 = 0 (COLLISION!)');
console.log(`encoderIndex[0] = ${64} (from pixel 0)`);
console.log('Check: index[idx] === val?');
console.log(`  index[0] === 0? NO (it's 64)`);
console.log('  => Emit FULL(0)');
console.log('Then: index[idx] = val');
console.log('  => index[0] = 0 (OVERWRITES 64!)\n');

console.log('=== DECODER CODE PATH FOR PIXEL 3 ===');
console.log('Reads: FULL(0)');
console.log('  => Returns value 0 ✓');
console.log('  => Updates index table');
console.log('  => decoderIndex[0] = 0\n');

console.log('=== AFTER FRAME 1 ===');
console.log(`Encoder index[0] = 0`);
console.log(`Decoder index[0] = 0`);
console.log(`✓ Actually they ARE in sync!\n`);

console.log('Hmm, so where does the desync come from?');
console.log('Let me check if the issue is that INDEX emitted but then overwritten...\n');

console.log('=== THE REAL BUG ===');
console.log('In encoder line 504: index[idx] = val is ALWAYS executed');
console.log('In decoder line 447: index is NOT updated after INDEX');
console.log('');
console.log('So if two pixels have the SAME value and hash:');
console.log('  Pixel A: val=64, idx=0');
console.log('    Encoder: index[0] = -1, emit FULL, then index[0] = 64');
console.log('    Decoder: index[0] = -1, read FULL, then index[0] = 64');
console.log('  Pixel B: val=64, idx=0 (same as A)');
console.log('    Encoder: index[0] = 64, emit INDEX(0), then index[0] = 64 (redundant)');
console.log('    Decoder: index[0] = 64, read INDEX(0), gets 64, but NO UPDATE');
console.log('');
console.log('After pixel B:');
console.log('  Encoder: index[0] = 64');
console.log('  Decoder: index[0] = 64');
console.log('  ✓ Still in sync because the value didnt change\n');

console.log('But what if next pixel overwrites due to collision?');
console.log('  Pixel C: val=128, idx=0 (collision!)');
console.log('    Encoder: index[0] = 64, not equal to 128, emit FULL(128), index[0] = 128');
console.log('    Decoder: reads FULL(128), index[0] = 128');
console.log('  ✓ Still in sync\n');

console.log('Hmm, I\'m not reproducing the bug...');
console.log('Let me check if the issue is between FRAMES (index table reset)...');
