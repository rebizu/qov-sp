// Review suite: randomized differential fuzz + regression repros for bugs
// found by hand that the frozen corpus did not cover. Deterministic seed so
// failures reproduce. Complements `npm run conformance` (golden corpus,
// cross-implementation) and `npm run selftest` (QOV-S transport):
//   node review_suite.cjs   (built by `npm run review`)
// Exit code 1 on any failure.

import { QovEncoder } from '../src/qov-encoder';
import { QovDecoder } from '../src/qov-decoder';
import { QovStreamingDecoder, StreamDataSource } from '../src/qov-streaming-decoder';
import { QovStreamSender, QovStreamReceiver } from '../src/qov-streaming';
import { inspectChunk } from '../src/qov-adaptation';
import { lz4Compress, lz4Decompress } from '../src/lz4';
import { rangeEncode, rangeDecode } from '../src/range-coder';
import {
  QOV_FLAG_HAS_INDEX, QOV_FLAG_HAS_MOTION, QOV_FLAG_LOSSY_MODE,
  QOV_FLAG_DCT_ENABLED, QOV_FLAG_INTRA_REFRESH,
} from '../src/qov-types';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) realLog(`  ok  ${label}`);
  else { failures++; realLog(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// silence codec chatter; failures still print through `check`
const realLog = console.log;
console.warn = () => {};
console.error = () => {};
console.log = () => {};

// ---------------------------------------------------------- helpers

let seed = 0x5eed1234;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

function makePixels(w: number, h: number, kind: string, f = 0): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (kind === 'noise') {
        px[o] = Math.floor(rnd() * 256); px[o + 1] = Math.floor(rnd() * 256); px[o + 2] = Math.floor(rnd() * 256);
      } else if (kind === 'flat') {
        px[o] = 90; px[o + 1] = 120; px[o + 2] = 30;
      } else if (kind === 'scroll16') {
        px[o] = (x + f * 16) & 0xff; px[o + 1] = (y * 2 + f * 16) & 0xff; px[o + 2] = ((x ^ y) + f) & 0xff;
      } else { // gradient
        px[o] = (x * 3 + y + f) & 0xff; px[o + 1] = (y * 5) & 0xff; px[o + 2] = ((x ^ y * 7) + f * 2) & 0xff;
      }
      px[o + 3] = 255;
    }
  }
  return px;
}

function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  const mse = sum / a.length;
  return mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
}

function decodeFull(data: Uint8Array): Uint8ClampedArray[] {
  const dec = new QovDecoder(data);
  dec.decodeHeader();
  const out: Uint8ClampedArray[] = [];
  for (const f of dec.decodeFrames()) if ('pixels' in f) out.push(f.pixels);
  return out;
}

async function decodeStreaming(data: Uint8Array, complete: boolean): Promise<Uint8ClampedArray[]> {
  const src: StreamDataSource = {
    getSize: () => (complete ? data.length : null),
    read: async (o, l) => data.subarray(o, o + l),
    isAvailable: (o, l) => o + l <= data.length,
    getLoadedSize: () => data.length,
    isComplete: complete ? () => true : undefined,
  };
  const sd = new QovStreamingDecoder(src);
  await sd.parseHeader();
  await sd.buildIndex();
  const out: Uint8ClampedArray[] = [];
  for (let i = 0; i < sd.getFrameCount(); i++) {
    const f = await sd.decodeFrame(i);
    if (f) out.push(f.pixels);
  }
  return out;
}

// ---------------------------------------------------------- A. codec fuzz

async function fuzzCodec(): Promise<{ minPsnr: number; n: number }> {
  const colorspaces: [number, string][] = [
    [0x00, 'srgb'], [0x01, 'srgba'], [0x10, 'yuv420'], [0x11, 'yuv422'], [0x12, 'yuv444'], [0x13, 'yuva420'],
  ];
  // odd sizes matter: partial DCT blocks, chroma ceil(), partial motion grid
  const dims = [[64, 48], [65, 47], [33, 17], [16, 16], [127, 3], [1, 1]];
  let minPsnr = 99;
  let structural = 0;

  for (let iter = 0; iter < 160; iter++) {
    const [cs, csName] = pick(colorspaces);
    const [w, h] = pick(dims);
    const lossy = rnd() < 0.6;
    const quality = pick([95, 60, 30]);
    const flags = 0x04
      | ((csName === 'srgba' || csName === 'yuva420') && rnd() < 0.7 ? 0x01 : 0)
      | (rnd() < 0.5 ? 0x02 : 0)
      | (lossy && rnd() < 0.5 ? 0x10 : 0)
      | (lossy && rnd() < 0.5 ? 0x80 : 0)
      | (rnd() < 0.4 ? 0x08 : 0);
    const compression = rnd() < 0.7;
    const range = lossy && rnd() < 0.4;
    const structured = lossy && rnd() < 0.4;
    const nFrames = 2 + Math.floor(rnd() * 4);
    const pattern = pick(['noise', 'gradient', 'flat', 'scroll16']);
    const label = `#${iter} ${csName} ${w}x${h} ${lossy ? `q=${quality}` : 'lossless'} flags=0x${flags.toString(16)} lz4=${compression} rc=${range} st=${structured} ${pattern}`;

    const frames: Uint8ClampedArray[] = [];
    for (let f = 0; f < nFrames; f++) frames.push(makePixels(w, h, pattern, f));

    let data: Uint8Array;
    try {
      const enc = new QovEncoder(w, h, 30, 1, flags, cs, compression, lossy ? quality : undefined, undefined, 0, 0, range, structured);
      enc.writeHeader();
      frames.forEach((px, i) => {
        if (i === 0 || rnd() < 0.2) enc.encodeKeyframe(px, i * 33333);
        else enc.encodePFrame(px, i * 33333);
      });
      data = enc.finish();
    } catch (e) { check(false, `fuzz encode ${label}`, (e as Error).message); structural++; continue; }

    let full: Uint8ClampedArray[];
    try { full = decodeFull(data); } catch (e) { check(false, `fuzz decode ${label}`, (e as Error).message); structural++; continue; }
    if (full.length !== nFrames) { check(false, `fuzz frame count ${label}`, `${full.length}/${nFrames}`); structural++; continue; }

    try {
      const stream = await decodeStreaming(data, true);
      if (stream.length !== full.length || stream.some((p, i) => p.length !== full[i].length || p.some((v, k) => v !== full[i][k]))) {
        check(false, `fuzz full==streaming ${label}`);
        structural++;
      }
    } catch (e) { check(false, `fuzz streaming ${label}`, (e as Error).message); structural++; continue; }

    if (!lossy && (csName === 'srgb' || csName === 'srgba')) {
      const src = frames[0], got = full[0];
      for (let k = 0; k < src.length; k += 4) {
        if (src[k] !== got[k] || src[k + 1] !== got[k + 1] || src[k + 2] !== got[k + 2]) {
          check(false, `fuzz RGB lossless exactness ${label} px ${k / 4}`);
          structural++;
          break;
        }
      }
    }
    const p = psnr(frames[0], full[0]);
    if (p < minPsnr) minPsnr = p;
    if (p < 5) { check(false, `fuzz PSNR ${label}`, `${p.toFixed(1)} dB`); structural++; }
  }
  return { minPsnr, n: structural };
}

// ------------------------------------------------- B. regression repros

// Found by hand review: uncompressed P-frames must count band + MV bytes in
// chunkSize (fixed in the encoder); these encode/decode roundtrips desynced.
function reproUncompressedMotion(): void {
  const W = 64, H = 64;
  const encode = (flags: number, compression: boolean, quality: number | undefined, n: number): Uint8Array => {
    const enc = new QovEncoder(W, H, 30, 1, flags, 0x10, compression, quality, undefined, 0, 0, false, false);
    enc.writeHeader();
    for (let i = 0; i < n; i++) {
      const px = makePixels(W, H, 'scroll16', i);
      if (i % 15 === 0) enc.encodeKeyframe(px, i * 33333);
      else enc.encodePFrame(px, i * 33333);
    }
    return enc.finish();
  };
  const lossyFlags = QOV_FLAG_HAS_INDEX | QOV_FLAG_HAS_MOTION | QOV_FLAG_LOSSY_MODE | QOV_FLAG_DCT_ENABLED | QOV_FLAG_INTRA_REFRESH;
  const losslessFlags = QOV_FLAG_HAS_INDEX | QOV_FLAG_HAS_MOTION;

  check(decodeFull(encode(lossyFlags, true, 60, 20)).length === 20, 'repro: lossy+motion, LZ4 on (control)');
  check(decodeFull(encode(lossyFlags, false, 60, 20)).length === 20, 'repro: uncompressed DCT + motion + refresh decodes all frames');
  check(decodeFull(encode(losslessFlags, false, undefined, 20)).length === 20, 'repro: uncompressed DPCM + motion decodes all frames');
}

// getFileStats must walk range-coded (0x08) chunks with the 4-byte size prefix.
function reproRangeStats(): void {
  const W = 64, H = 64;
  const enc = new QovEncoder(W, H, 30, 1, QOV_FLAG_HAS_INDEX | QOV_FLAG_HAS_MOTION | QOV_FLAG_LOSSY_MODE | QOV_FLAG_DCT_ENABLED | QOV_FLAG_INTRA_REFRESH, 0x10, true, 60, undefined, 0, 0, true, true);
  enc.writeHeader();
  for (let i = 0; i < 20; i++) {
    const px = makePixels(W, H, 'scroll16', i);
    if (i % 15 === 0) enc.encodeKeyframe(px, i * 33333);
    else enc.encodePFrame(px, i * 33333);
  }
  const data = enc.finish();
  const dec = new QovDecoder(data);
  dec.decodeHeader();
  const stats = dec.getFileStats();
  const frameChunks = stats.chunks.filter(c => c.type === 0x01 || c.type === 0x02).length;
  check(frameChunks === 20, 'repro: getFileStats walks range-coded file', `saw ${frameChunks}/20 frame chunks`);

  // inspectChunk: band byte sits after the size prefix of a RANGE+band chunk
  let pos = 32, verified = false;
  while (pos + 10 < data.length) {
    const type = data[pos], flags = data[pos + 1];
    const size = ((data[pos + 2] << 24) | (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5]) >>> 0;
    if (type === 0x02 && (flags & 0x08) !== 0 && (flags & 0x80) !== 0) {
      const info = inspectChunk(data.subarray(pos, pos + 10 + size));
      check(info.hasRefreshBand, 'repro: inspectChunk sees refresh band on range-coded chunk');
      verified = true;
      break;
    }
    pos += 10 + size;
  }
  if (!verified) check(false, 'repro: no range+band P-frame found for inspectChunk');
}

// ---------------------------------------------- C. transport / sources

// buildIndex must stop at EOF on complete sources with unknown size instead
// of waiting forever (URL served without content-length).
async function testBuildIndexEof(): Promise<void> {
  const enc = new QovEncoder(32, 32, 30, 1, QOV_FLAG_HAS_INDEX, 0x00, true, undefined);
  enc.writeHeader();
  enc.encodeKeyframe(new Uint8ClampedArray(32 * 32 * 4).fill(80), 0);
  const data = enc.finish();

  const src: StreamDataSource = {
    getSize: () => null,
    isComplete: () => true,
    read: async (o, l) => data.subarray(o, o + l),
    isAvailable: (o, l) => o + l <= data.length,
    getLoadedSize: () => data.length,
  };
  const sd = new QovStreamingDecoder(src);
  await sd.parseHeader();
  const hang = new Promise<{ hung: true }>(res => setTimeout(() => res({ hung: true }), 2000));
  const built = sd.buildIndex().then((): { hung: boolean } => ({ hung: false }));
  const r = await Promise.race([built, hang]);
  check(!r.hung && sd.getFrameCount() === 1, 'buildIndex stops at EOF on complete unknown-size source');
}

// A peer restart reuses frame ids from 0; the receiver must accept them
// after reset() instead of rejecting everything as late.
function testReceiverReset(): void {
  const mk = (i: number): Uint8Array => new Uint8Array([0x01, 0x00, 0, 8, 0, 0, 0, 0, 0, 0, 0, i, 0, 0, 0, i, 0, 1]);
  const wire1: Uint8Array[] = [];
  const s1 = new QovStreamSender(p => wire1.push(p));
  for (let i = 1; i <= 4; i++) s1.sendChunk(mk(i), false);

  const delivered: number[] = [];
  const rx = new QovStreamReceiver(c => delivered.push(c[c.length - 1]), () => {}, { frameIntervalMs: 20 });
  rx.start();
  wire1.forEach(p => rx.handlePacket(p));
  const afterFirst = delivered.length;

  rx.reset();
  const wire2: Uint8Array[] = [];
  const s2 = new QovStreamSender(p => wire2.push(p));
  for (let i = 5; i <= 7; i++) s2.sendChunk(mk(i), false);
  wire2.forEach(p => rx.handlePacket(p));
  rx.stop();

  check(afterFirst === 4 && delivered.length === 7, 'receiver reset accepts restarted frame-id space', `after1=${afterFirst} total=${delivered.length}`);
}

// dropReference: the next encodePFrame must re-key and stay decodable.
async function testDropReference(): Promise<void> {
  const W = 64, H = 64;
  const enc = new QovEncoder(W, H, 30, 1, QOV_FLAG_HAS_INDEX | QOV_FLAG_HAS_MOTION | QOV_FLAG_LOSSY_MODE | QOV_FLAG_DCT_ENABLED, 0x10, true, 60, undefined, 0, 0, false, false);
  enc.writeHeader();
  const frames: Uint8ClampedArray[] = [];
  for (let i = 0; i < 6; i++) frames.push(makePixels(W, H, 'gradient', i * 8));
  frames.forEach((px, i) => {
    if (i === 0) enc.encodeKeyframe(px, i * 33333);
    else {
      if (i === 3) enc.dropReference();
      enc.encodePFrame(px, i * 33333); // falls back to a keyframe after the drop
    }
  });
  const data = enc.finish();
  const full = decodeFull(data);
  const stream = await decodeStreaming(data, true);
  const okCount = full.length === 6 && stream.length === 6;
  const okEqual = okCount && stream.every((p, i) => p.every((v, k) => v === full[i][k]));
  const p = psnr(frames[5], full[5]);
  check(okCount && okEqual && p > 20, 'dropReference re-keys and stays decodable', `count=${full.length} equal=${okEqual} psnr=${p.toFixed(1)}`);
}

// ------------------------------------------------ D. legacy v1 files

// Version 0x01 (16-bit chunk sizes) predates the encoder's v2/v3 output;
// both TS decoders must still read it.
function testV1Legacy(): void {
  const W = 4, H = 4;
  const bytes: number[] = [];
  const u8 = (v: number): void => { bytes.push(v & 0xff); };
  const u16 = (v: number): void => { bytes.push((v >> 8) & 0xff, v & 0xff); };
  const u32 = (v: number): void => { bytes.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); };
  const marker = (): void => { for (let i = 0; i < 7; i++) u8(0); u8(1); };

  // header (24 bytes, v1)
  for (const ch of 'qovf') u8(ch.charCodeAt(0));
  u8(0x01);          // version: 16-bit chunk sizes
  u8(0x00);          // flags
  u16(W); u16(H);
  u16(30); u16(1);
  u32(2);            // totalFrames
  u8(0);             // audioChannels
  u8(0); u8(0); u8(0); // audioRate
  u8(0x00);          // colorspace sRGB
  u8(0);             // quality

  // SYNC
  u8(0x00); u8(0x00); u16(8); u32(0);
  for (const ch of 'QOVS') u8(ch.charCodeAt(0));
  u32(0);

  // KEYFRAME: 16 distinct pixels via RGB literals, deterministic pattern
  const kfPayload: number[] = [];
  const kfPush = (v: number): void => { kfPayload.push(v & 0xff); };
  for (let i = 0; i < W * H; i++) {
    kfPush(0xfe); kfPush((i * 17) & 0xff); kfPush((i * 31 + 5) & 0xff); kfPush((i * 7 + 1) & 0xff);
  }
  for (let i = 0; i < 7; i++) kfPush(0);
  kfPush(1);
  u8(0x01); u8(0x00); u16(kfPayload.length); u32(33333);
  bytes.push(...kfPayload);

  // P-frame: all pixels unchanged (skip run), so frame 2 must equal frame 1
  const pPayload: number[] = [0xc0 | (W * H - 1)];
  for (let i = 0; i < 7; i++) pPayload.push(0);
  pPayload.push(1);
  u8(0x02); u8(0x00); u16(pPayload.length); u32(66666);
  bytes.push(...pPayload);

  // END + marker
  u8(0xff); u8(0x00); u16(0); u32(0);
  marker();

  const data = new Uint8Array(bytes);
  const full = decodeFull(data);
  const kfOk = full.length === 2
    && full[0][3] === 255
    && full[0][0] === 0 && full[0][1] === 5 && full[0][2] === 1   // px 0 literal
    && full[0][(15 * 4)] === (15 * 17) & 0xff;                     // px 15 literal
  const skipOk = full.length === 2 && full[1].every((v, k) => v === full[0][k]);
  check(kfOk, 'v1 keyframe decodes (16-bit chunk header)');
  check(skipOk, 'v1 P-frame skip retains reference');

  decodeStreaming(data, true).then(stream => {
    check(stream.length === 2 && stream[1].every((v, k) => v === full[1][k]), 'v1 decodes identically via streaming decoder');
  });
}

// ------------------------------------------------ E. compression primitives

function fuzzCompressors(): void {
  let lz4Bad = 0, rcBad = 0;
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rnd() * 300);
    const buf = new Uint8Array(n);
    const kind = i % 3;
    for (let k = 0; k < n; k++) buf[k] = kind === 0 ? Math.floor(rnd() * 256) : kind === 1 ? (k % 7) : 42;
    if (rnd() < 0.3 && n > 10) buf.fill(buf[3], 3, n - 3);
    const c = lz4Compress(buf);
    if (!c) continue;
    const d = lz4Decompress(c, buf.length);
    for (let k = 0; k < n; k++) if (d[k] !== buf[k]) { lz4Bad++; break; }
  }
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(rnd() * 2000);
    if (n === 0) continue;
    const buf = new Uint8Array(n);
    const kind = i % 4;
    for (let k = 0; k < n; k++) buf[k] = kind === 0 ? Math.floor(rnd() * 256) : kind === 1 ? (k % 3) : kind === 2 ? 200 : Math.floor(rnd() * 2);
    const d = rangeDecode(rangeEncode(buf), n);
    for (let k = 0; k < n; k++) if (d[k] !== buf[k]) { rcBad++; break; }
  }
  check(lz4Bad === 0, 'lz4 roundtrip fuzz (2000 inputs)', `${lz4Bad} mismatches`);
  check(rcBad === 0, 'range coder roundtrip fuzz (500 inputs)', `${rcBad} mismatches`);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  realLog('review suite');
  realLog('  codec fuzz (160 configs, odd dimensions, all colorspaces/flags)...');
  const { minPsnr, n } = await fuzzCodec();
  check(n === 0, 'codec fuzz: 160 configs, no structural failures', `${n} structural issues`);

  realLog('  regression repros...');
  reproUncompressedMotion();
  reproRangeStats();

  realLog('  transport and sources...');
  await testBuildIndexEof();
  testReceiverReset();
  await testDropReference();

  realLog('  legacy v1 files...');
  testV1Legacy();
  await new Promise(res => setTimeout(res, 50)); // let the streaming v1 check land

  realLog('  compression primitives...');
  fuzzCompressors();

  console.log = realLog;
  if (failures === 0) {
    console.log(`REVIEW SUITE GREEN (worst-case lossy PSNR seen: ${minPsnr.toFixed(1)} dB)`);
    process.exit(0);
  } else {
    console.log(`REVIEW SUITE FAILED: ${failures} failure(s)`);
    process.exit(1);
  }
}

main();
