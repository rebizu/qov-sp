// Node CLI over the real src/ QOV codec — used by the corpus generator and
// conformance runner. Not part of the browser build.
//
// Commands:
//   node tscli.cjs encode <case.json> <out.qov>
//   node tscli.cjs decode <file.qov> [--streaming] [--raw <dir>]
//
// decode prints a JSON report to stdout: {frames, frameSha256, header, audioFrames}.
// Deterministic patterns (must stay in sync with csharp_qov/QovEncoder):
//   gradient | stripes | scroll16 | noise — see qov-analysis-tools/README.md.

const colorspaceIds: Record<string, number> = {
  srgb: 0x00, srgba: 0x01, linear: 0x02, linear_a: 0x03,
  yuv420: 0x10, yuv422: 0x11, yuv444: 0x12, yuva420: 0x13,
};

const FLAG_BITS: Record<string, number> = { index: 0x04, alpha: 0x01, motion: 0x02 };

// Deterministic 31-bit LCG shared with the C# generator (see README)
function lcgNext(s: number): number {
  return (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
}
function lcgByte(s: number): [number, number] {
  const ns = lcgNext(s);
  return [ns, (ns >>> 16) & 0xff];
}

interface Case {
  id: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  colorspace: string;
  flags?: string[];            // subset of index|alpha|motion
  quality?: number;            // undefined = lossless
  compression?: boolean;       // default true
  pattern: string;             // gradient|stripes|scroll16|noise
  keyframeInterval?: number;   // default 2
  audio?: { channels: number; rate: number } | null;
}

function makeFrame(c: Case, n: number): Uint8ClampedArray {
  const w = c.width, h = c.height;
  const px = new Uint8ClampedArray(w * h * 4);
  const pal = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128]];
  let s = 12345 + n * 7919; // per-frame rng seed for noise
  const hasAlphaCh = (c.flags ?? []).includes('alpha') || ['srgba', 'linear_a', 'yuva420'].includes(c.colorspace);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 0, g = 0, b = 0;
      if (c.pattern === 'gradient') {
        r = Math.round((x * 255) / Math.max(1, w - 1));
        g = Math.round((y * 255) / Math.max(1, h - 1));
        b = (x + y + n * 4) & 0xff;
      } else if (c.pattern === 'stripes') {
        const p = pal[(Math.floor(x / 16) + n) % pal.length];
        r = p[0]; g = p[1]; b = p[2];
      } else if (c.pattern === 'scroll16') {
        const u = (x + n * 16) % w;
        r = (u * 3 + y) & 0xff;
        g = (u + y * 2) & 0xff;
        b = ((u * u + y) & 0xff);
      } else if (c.pattern === 'noise') {
        [s, r] = lcgByte(s);
        [s, g] = lcgByte(s);
        [s, b] = lcgByte(s);
      } else {
        throw new Error(`unknown pattern ${c.pattern}`);
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
      px[i + 3] = hasAlphaCh ? ((x + n * 8) & 0xff) : 255;
    }
  }
  return px;
}

async function main(): Promise<void> {
  const mute = process.argv[2] === '-q';
  if (mute) {
    // codec is chatty; silence it for all but fatal output, then shift args
    console.log = () => { };
    console.warn = () => { };
    console.error = () => { };
    process.argv.splice(2, 1);
  }
  const [, , cmd, a, b] = process.argv;
  const { createHash } = await import('node:crypto');
  const fs = await import('node:fs');
  const sha = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');

  if (cmd === 'encode') {
    const c: Case = JSON.parse(fs.readFileSync(a, 'utf8'));
    const { QovEncoder } = await import('../src/qov-encoder');
    let flags = 0;
    for (const f of c.flags ?? []) flags |= FLAG_BITS[f] ?? 0;
    if (!(c.flags ?? []).includes('index')) flags |= 0x04; // index on unless explicitly off
    const compression = c.compression ?? true;
    const audio = c.audio ?? null;
    const enc = new QovEncoder(c.width, c.height, c.fps, 1, flags, colorspaceIds[c.colorspace], compression, c.quality, undefined, audio ? audio.channels : 0, audio ? audio.rate : 0);
    enc.writeHeader();
    const kf = c.keyframeInterval ?? 2;
    for (let n = 0; n < c.frames; n++) {
      const frame = makeFrame(c, n);
      if (n % kf === 0) enc.encodeKeyframe(frame, Math.round((n * 1e6) / c.fps));
      else enc.encodePFrame(frame, Math.round((n * 1e6) / c.fps));
      if (audio) {
        // one QOA frame per call: 256 samples per channel, deterministic sine sweep
        const samples = new Float32Array(256 * audio.channels);
        for (let i = 0; i < 256; i++) {
          const v = Math.round(Math.sin((2 * Math.PI * 440 * (n * 256 + i)) / audio.rate) * 16000) / 32768;
          for (let ch = 0; ch < audio.channels; ch++) samples[i * audio.channels + ch] = v;
        }
        enc.encodeAudio(samples, Math.round((n * 1e6) / c.fps));
      }
    }
    fs.writeFileSync(b, enc.finish());
    process.stdout.write('OK\n');
    return;
  }

  if (cmd === 'decode') {
    const file = a;
    const streaming = process.argv.includes('--streaming');
    const rawDirIdx = process.argv.indexOf('--raw');
    const rawDir = rawDirIdx > 0 ? process.argv[rawDirIdx + 1] : null;
    const data = new Uint8Array(fs.readFileSync(file));
    const report: any = { file: file, fileSha256: sha(data), frames: 0, frameSha256: [], audioFrames: 0, header: {} };
    if (streaming) {
      const { QovStreamingDecoder, FileDataSource } = await import('../src/qov-streaming-decoder');
      const dec = new QovStreamingDecoder(new FileDataSource(data));
      const header = await dec.parseHeader();
      await dec.buildIndex();
      report.header = { version: header.version, colorspace: header.colorspace, flags: header.flags, width: header.width, height: header.height, totalFrames: header.totalFrames };
      const total = header.totalFrames > 0 ? header.totalFrames : (dec as any).totalFrames;
      for (let i = 0; i < total; i++) {
        const f = await dec.decodeFrame(i);
        if (!f) break;
        report.frameSha256.push(sha(f.pixels));
        report.frames++;
      }
    } else {
      const { QovDecoder } = await import('../src/qov-decoder');
      const dec = new QovDecoder(data);
      const header = dec.decodeHeader();
      report.header = { version: header.version, colorspace: header.colorspace, flags: header.flags, width: header.width, height: header.height, totalFrames: header.totalFrames, audioChannels: header.audioChannels };
      for (const f of dec.decodeFrames()) {
        if ((f as any).samples) { report.audioFrames++; continue; }
        report.frameSha256.push(sha(f.pixels));
        report.frames++;
        if (rawDir) fs.writeFileSync(`${rawDir}/frame_${report.frames - 1}.rgba`, Buffer.from(f.pixels.buffer, f.pixels.byteOffset, f.pixels.length));
      }
    }
    process.stdout.write(JSON.stringify(report));
    return;
  }

  throw new Error(`unknown command: ${cmd ?? '(none)'}`);
}

main().catch(e => { process.stderr.write(`tscli ERROR: ${e?.message ?? e}\n`); process.exit(2); });
