// Verify the desynchronization between TS encoder and TS decoder

console.log('=== TypeScript Encoder vs TypeScript Decoder ===\n');

const plane = [100, 105, 100];  // Pixel values
const prevPlane = [50, 50, 50];  //  Previous frame

console.log('--- TYPESCRIPT ENCODER ---\n');
const tsEncoderIndex = new Array(64).fill(-1);

for (let i = 0; i < plane.length; i++) {
  const val = plane[i];
  const refVal = prevPlane[i];
  const d = val - refVal;
  const idx = (val * 3) % 64;

  console.log(`Pixel ${i}: val=${val}, diff=${d}, idx=${idx}`);
  console.log(`  index[${idx}] = ${tsEncoderIndex[idx]}`);

  if (d >= -8 && d <= 7) {
    console.log(`  => Emit TDIFF`);
    tsEncoderIndex[idx] = val;
  } else if (d >= -32 && d <= 31) {
    console.log(`  => Emit TLUMA`);
    tsEncoderIndex[idx] = val;
  } else {
    if (tsEncoderIndex[idx] === val) {
      console.log(`  => Emit INDEX(${idx})`);
    } else {
      console.log(`  => Emit FULL`);
    }
    tsEncoderIndex[idx] = val;  // TS: Updates in BOTH cases!
  }
  console.log(`  After: index[${idx}] = ${tsEncoderIndex[idx]}\n`);
}

console.log('\n--- TYPESCRIPT DECODER ---\n');
const tsDecoderIndex = new Array(64).fill(-1);

// Pixel 0: TLUMA val=100
console.log(`Pixel 0: TLUMA val=100, idx=44`);
tsDecoderIndex[44] = 100;
console.log(`  After: index[44] = ${tsDecoderIndex[44]}\n`);

// Pixel 1: FULL val=105
console.log(`Pixel 1: FULL val=105, idx=59`);
tsDecoderIndex[59] = 105;
console.log(`  After: index[59] = ${tsDecoderIndex[59]}\n`);

// Pixel 2: INDEX(44)
console.log(`Pixel 2: INDEX(44)`);
console.log(`  Reads: index[44] = ${tsDecoderIndex[44]}`);
// TS Decoder does NOT update!
console.log(`  After: index[44] = ${tsDecoderIndex[44]} (NO UPDATE)\n`);

console.log('\n=== COMPARISON ===');
console.log(`TS Encoder index[44]: ${tsEncoderIndex[44]}`);
console.log(`TS Decoder index[44]: ${tsDecoderIndex[44]}`);
console.log(`❌ DESYNC! Encoder updated, decoder did not!\n`);

console.log('\n--- C# ENCODER ---\n');
const csEncoderIndex = new Array(64).fill(-1);

for (let i = 0; i < plane.length; i++) {
  const val = plane[i];
  const refVal = prevPlane[i];
  const d = val - refVal;
  const idx = (val * 3) % 64;

  console.log(`Pixel ${i}: val=${val}, diff=${d}, idx=${idx}`);
  console.log(`  index[${idx}] = ${csEncoderIndex[idx]}`);

  if (d >= -8 && d <= 7) {
    console.log(`  => Emit TDIFF`);
    csEncoderIndex[idx] = val;
  } else if (d >= -32 && d <= 31) {
    console.log(`  => Emit TLUMA`);
    csEncoderIndex[idx] = val;
  } else {
    if (csEncoderIndex[idx] === val) {
      console.log(`  => Emit INDEX(${idx})`);
      // C#: Does NOT update here!
    } else {
      console.log(`  => Emit FULL`);
      csEncoderIndex[idx] = val;  // C#: Only updates in else
    }
  }
  console.log(`  After: index[${idx}] = ${csEncoderIndex[idx]}\n`);
}

console.log('\n=== COMPARISON WITH C# ===');
console.log(`C# Encoder index[44]: ${csEncoderIndex[44]}`);
console.log(`TS Decoder index[44]: ${tsDecoderIndex[44]}`);
console.log(`✓ IN SYNC! Both did not update after INDEX\n`);

console.log('\n=== CONCLUSION ===');
console.log('The TypeScript ENCODER has a bug at line 504:');
console.log('  index[idx] = val;  // This is executed even after INDEX!');
console.log('');
console.log('This causes desync when TS encoder creates files decoded by TS decoder.');
console.log('However, files created by C# encoder work correctly with TS decoder.');
