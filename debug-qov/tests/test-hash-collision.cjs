// Test if hash collisions cause INDEX errors

console.log('Testing hash function (val * 3) % 64:\n');

// Find all collisions
const hashMap = new Map();
for (let val = 0; val < 256; val++) {
  const idx = (val * 3) % 64;
  if (!hashMap.has(idx)) {
    hashMap.set(idx, []);
  }
  hashMap.get(idx).push(val);
}

// Show collisions
let totalCollisions = 0;
for (const [idx, vals] of hashMap.entries()) {
  if (vals.length > 1) {
    console.log(`Index ${idx}: values ${vals.join(', ')} (${vals.length} collisions)`);
    totalCollisions += vals.length - 1;
  }
}

console.log(`\nTotal collision pairs: ${totalCollisions}`);
console.log(`\nThis means if encoder writes TDIFF for val=0 (idx=0), then later`);
console.log(`encounters val=64 with large diff, it will check index[0] which`);
console.log(`now contains 0, not 64, so it will emit FULL.`);
console.log(`\nBut if encoder encounters val=64 AGAIN later, it will check`);
console.log(`index[0], find it's 0 (not 64), so emit FULL again.`);
console.log(`The encoder never emits INDEX for a collision.`);

console.log(`\n--- Simulation ---`);

// Simulate encoder behavior
const index = new Array(64).fill(-1);

function encode(val, label) {
  const idx = (val * 3) % 64;
  console.log(`\n${label}: val=${val}, idx=${idx}`);
  console.log(`  index[${idx}] = ${index[idx]}`);

  if (index[idx] === val) {
    console.log(`  => Emit INDEX(${idx}) ✓`);
  } else {
    console.log(`  => Emit FULL(${val})`);
    index[idx] = val;
  }
}

// Scenario 1: Same value twice
encode(100, 'Pixel A');
encode(100, 'Pixel B');

// Scenario 2: Collision
encode(0, 'Pixel C');
encode(64, 'Pixel D');
encode(64, 'Pixel E');

console.log(`\nSo hash collisions should NOT cause incorrect INDEX emission.`);
console.log(`The encoder only emits INDEX when index[idx] === val.`);
