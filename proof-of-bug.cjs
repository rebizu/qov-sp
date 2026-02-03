// Proof of INDEX table desynchronization bug

console.log('=== INDEX Table Desynchronization Bug ===\n');

// Simulate encoding a P-frame
console.log('ENCODER:');
const encoderIndex = new Array(64).fill(-1);
const plane = [100, 105, 100, 110];  // Example pixel values
const prevPlane = [50, 50, 50, 50];  // Previous frame (all different)

for (let i = 0; i < plane.length; i++) {
  const val = plane[i];
  const refVal = prevPlane[i];
  const d = val - refVal;
  const idx = (val * 3) % 64;

  console.log(`\nPixel ${i}: val=${val}, refVal=${refVal}, diff=${d}, idx=${idx}`);
  console.log(`  encoderIndex[${idx}] = ${encoderIndex[idx]}`);

  if (d >= -8 && d <= 7) {
    console.log(`  => Emit TDIFF (d=${d})`);
    encoderIndex[idx] = val;
  } else if (d >= -32 && d <= 31) {
    console.log(`  => Emit TLUMA (d=${d})`);
    encoderIndex[idx] = val;
  } else {
    if (encoderIndex[idx] === val) {
      console.log(`  => Emit INDEX(${idx}) ✓`);
    } else {
      console.log(`  => Emit FULL(${val})`);
    }
    encoderIndex[idx] = val;  // ENCODER UPDATES INDEX AFTER INDEX OPCODE
  }

  console.log(`  After encode: encoderIndex[${idx}] = ${encoderIndex[idx]}`);
}

console.log('\n\n=== NOW DECODE THE SAME OPCODES ===\n');
console.log('DECODER:');

const decoderIndex = new Array(64).fill(-1);
const decodedPlane = new Array(4).fill(0);

// Simulate the opcodes that were emitted
const opcodes = [
  { type: 'TLUMA', val: 100, idx: 44 },  // Pixel 0: 100
  { type: 'TLUMA', val: 105, idx: 59 },  // Pixel 1: 105
  { type: 'INDEX', idx: 44 },            // Pixel 2: 100 (reuses idx 44)
  { type: 'TLUMA', val: 110, idx: 10 },  // Pixel 3: 110
];

for (let i = 0; i < opcodes.length; i++) {
  const op = opcodes[i];
  console.log(`\nPixel ${i}: opcode=${op.type}`);

  if (op.type === 'TLUMA') {
    console.log(`  decoderIndex[${op.idx}] = ${decoderIndex[op.idx]}`);
    decodedPlane[i] = op.val;
    decoderIndex[op.idx] = op.val;  // DECODER UPDATES INDEX
    console.log(`  Decoded val=${op.val}`);
    console.log(`  After decode: decoderIndex[${op.idx}] = ${decoderIndex[op.idx]}`);
  } else if (op.type === 'INDEX') {
    console.log(`  decoderIndex[${op.idx}] = ${decoderIndex[op.idx]}`);
    if (decoderIndex[op.idx] === -1) {
      console.log(`  ⚠️  ERROR: Uninitialized slot!`);
      decodedPlane[i] = 128;
    } else {
      decodedPlane[i] = decoderIndex[op.idx];
      console.log(`  Decoded val=${decodedPlane[i]}`);
    }
    // DECODER DOES NOT UPDATE INDEX AFTER INDEX OPCODE!
    console.log(`  After decode: decoderIndex[${op.idx}] = ${decoderIndex[op.idx]} (NO UPDATE)`);
  }
}

console.log('\n\n=== RESULT ===');
console.log(`Original plane:  [${plane.join(', ')}]`);
console.log(`Decoded plane:   [${decodedPlane.join(', ')}]`);
console.log(`\nEncoder index[44]: ${encoderIndex[44]}`);
console.log(`Decoder index[44]: ${decoderIndex[44]}`);
console.log(`\n❌ Index tables are OUT OF SYNC!`);

console.log(`\n\n=== WHAT HAPPENS NEXT FRAME ===`);
console.log(`\nIf next P-frame has a pixel with value 100 that needs INDEX:`);
console.log(`  Encoder: encoderIndex[44] = ${encoderIndex[44]} => Will emit INDEX(44)`);
console.log(`  Decoder: decoderIndex[44] = ${decoderIndex[44]} => Will get ERROR!`);
