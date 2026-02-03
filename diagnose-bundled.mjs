#!/usr/bin/env node

// diagnose-qov.mjs
import fs from "fs";

// diagnostic-build/qov-types.js
var QOV_FLAG_HAS_ALPHA = 1;
var QOV_COLORSPACE_YUV420 = 16;
var QOV_COLORSPACE_YUV422 = 17;
var QOV_COLORSPACE_YUVA420 = 19;
var QOV_CHUNK_SYNC = 0;
var QOV_CHUNK_KEYFRAME = 1;
var QOV_CHUNK_PFRAME = 2;
var QOV_CHUNK_BFRAME = 3;
var QOV_CHUNK_AUDIO = 16;
var QOV_CHUNK_INDEX = 240;
var QOV_CHUNK_END = 255;
var QOV_CHUNK_FLAG_COMPRESSED = 16;
function getChunkTypeName(type) {
  switch (type) {
    case QOV_CHUNK_SYNC:
      return "SYNC";
    case QOV_CHUNK_KEYFRAME:
      return "KEYFRAME";
    case QOV_CHUNK_PFRAME:
      return "PFRAME";
    case QOV_CHUNK_BFRAME:
      return "BFRAME";
    case QOV_CHUNK_AUDIO:
      return "AUDIO";
    case QOV_CHUNK_INDEX:
      return "INDEX";
    case QOV_CHUNK_END:
      return "END";
    default:
      return `UNKNOWN(0x${type.toString(16)})`;
  }
}

// diagnostic-build/lz4.js
function lz4Decompress(input, outputSize) {
  if (input.length === 0) {
    return new Uint8Array(0);
  }
  const output = new Uint8Array(outputSize);
  let inPos = 0;
  let outPos = 0;
  while (inPos < input.length) {
    const token = input[inPos++];
    const literalLen = token >> 4;
    const matchLen = token & 15;
    let litLen = literalLen;
    if (literalLen === 15) {
      let b;
      do {
        b = input[inPos++];
        litLen += b;
      } while (b === 255);
    }
    for (let i = 0; i < litLen; i++) {
      output[outPos++] = input[inPos++];
    }
    if (inPos >= input.length) {
      break;
    }
    const offset = input[inPos++] | input[inPos++] << 8;
    let mLen = matchLen + 4;
    if (matchLen === 15) {
      let b;
      do {
        b = input[inPos++];
        mLen += b;
      } while (b === 255);
    }
    const matchPos = outPos - offset;
    for (let i = 0; i < mLen; i++) {
      output[outPos++] = output[matchPos + i];
    }
  }
  return output;
}

// diagnostic-build/color-utils.js
function yuvToRgb(y, u, v) {
  const r = Math.round(y + 1.402 * (v - 128));
  const g = Math.round(y - 0.344 * (u - 128) - 0.714 * (v - 128));
  const b = Math.round(y + 1.772 * (u - 128));
  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b))
  };
}
function yuv420PlanesToRgba(yPlane, uPlane, vPlane, aPlane, width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const uvWidth = Math.ceil(width / 2);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const yIdx = py * width + px;
      const uvIdx = Math.floor(py / 2) * uvWidth + Math.floor(px / 2);
      const y = yPlane[yIdx];
      const u = uPlane[uvIdx];
      const v = vPlane[uvIdx];
      const rgb = yuvToRgb(y, u, v);
      const outIdx = yIdx * 4;
      pixels[outIdx] = rgb.r;
      pixels[outIdx + 1] = rgb.g;
      pixels[outIdx + 2] = rgb.b;
      pixels[outIdx + 3] = aPlane ? aPlane[yIdx] : 255;
    }
  }
  return pixels;
}
function yuv422PlanesToRgba(yPlane, uPlane, vPlane, aPlane, width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const uvWidth = Math.ceil(width / 2);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const yIdx = py * width + px;
      const uvIdx = py * uvWidth + Math.floor(px / 2);
      const y = yPlane[yIdx];
      const u = uPlane[uvIdx];
      const v = vPlane[uvIdx];
      const rgb = yuvToRgb(y, u, v);
      const outIdx = yIdx * 4;
      pixels[outIdx] = rgb.r;
      pixels[outIdx + 1] = rgb.g;
      pixels[outIdx + 2] = rgb.b;
      pixels[outIdx + 3] = aPlane ? aPlane[yIdx] : 255;
    }
  }
  return pixels;
}
function yuv444PlanesToRgba(yPlane, uPlane, vPlane, aPlane, width, height) {
  const size = width * height;
  const pixels = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const y = yPlane[i];
    const u = uPlane[i];
    const v = vPlane[i];
    const rgb = yuvToRgb(y, u, v);
    const outIdx = i * 4;
    pixels[outIdx] = rgb.r;
    pixels[outIdx + 1] = rgb.g;
    pixels[outIdx + 2] = rgb.b;
    pixels[outIdx + 3] = aPlane ? aPlane[i] : 255;
  }
  return pixels;
}

// diagnostic-build/qov-decoder.js
var QovDecoder = class {
  constructor(data) {
    this.pos = 0;
    this.index = new Array(64);
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };
    this.prevFrame = null;
    this.currFrame = null;
    this.use32BitChunkSize = false;
    this.frameCount = 0;
    this.isYuvMode = false;
    this.hasYuvAlpha = false;
    this.prevYPlane = null;
    this.prevUPlane = null;
    this.prevVPlane = null;
    this.prevAPlane = null;
    this.currYPlane = null;
    this.currUPlane = null;
    this.currVPlane = null;
    this.currAPlane = null;
    this.activeData = null;
    this.activePos = 0;
    this.data = data;
    this.resetIndex();
  }
  resetIndex() {
    for (let i = 0; i < 64; i++) {
      this.index[i] = { r: 0, g: 0, b: 0, a: 0 };
    }
  }
  readU8() {
    if (this.activeData) {
      return this.activeData[this.activePos++];
    }
    return this.data[this.pos++];
  }
  readU16() {
    return this.readU8() << 8 | this.readU8();
  }
  readU32() {
    return this.readU8() << 24 | this.readU8() << 16 | this.readU8() << 8 | this.readU8();
  }
  // Setup to read from decompressed data
  setActiveData(data) {
    this.activeData = data;
    this.activePos = 0;
  }
  colorHash(c) {
    return (c.r * 3 + c.g * 5 + c.b * 7 + c.a * 11) % 64;
  }
  decodeHeader() {
    this.pos = 0;
    const magic = String.fromCharCode(this.data[0], this.data[1], this.data[2], this.data[3]);
    if (magic !== "qovf") {
      throw new Error(`Invalid QOV magic: ${magic}`);
    }
    this.pos = 4;
    const version = this.readU8();
    if (version !== 1 && version !== 2) {
      throw new Error(`Unsupported QOV version: ${version}`);
    }
    this.use32BitChunkSize = version >= 2;
    console.log(`[Decoder] Version 0x${version.toString(16)}, 32-bit chunks: ${this.use32BitChunkSize}`);
    this.header = {
      magic,
      version,
      flags: this.readU8(),
      width: this.readU16(),
      height: this.readU16(),
      frameRateNum: this.readU16(),
      frameRateDen: this.readU16(),
      totalFrames: this.readU32(),
      audioChannels: this.readU8(),
      audioRate: this.readU8() << 16 | this.readU8() << 8 | this.readU8(),
      colorspace: this.readU8()
    };
    this.pos++;
    const cs = this.header.colorspace;
    this.isYuvMode = cs >= QOV_COLORSPACE_YUV420 && cs <= QOV_COLORSPACE_YUVA420;
    this.hasYuvAlpha = (this.header.flags & QOV_FLAG_HAS_ALPHA) !== 0 || cs === QOV_COLORSPACE_YUVA420;
    console.log(`[Decoder] Colorspace: 0x${cs.toString(16)}, YUV mode: ${this.isYuvMode}, Has alpha: ${this.hasYuvAlpha}`);
    const pixelCount = this.header.width * this.header.height * 4;
    this.prevFrame = new Uint8ClampedArray(pixelCount);
    this.currFrame = new Uint8ClampedArray(pixelCount);
    for (let i = 3; i < pixelCount; i += 4) {
      this.prevFrame[i] = 255;
      this.currFrame[i] = 255;
    }
    if (this.isYuvMode) {
      const { width, height } = this.header;
      const ySize = width * height;
      let uvSize;
      if (cs === QOV_COLORSPACE_YUV420 || cs === QOV_COLORSPACE_YUVA420) {
        uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
      } else if (cs === QOV_COLORSPACE_YUV422) {
        uvSize = Math.ceil(width / 2) * height;
      } else {
        uvSize = ySize;
      }
      this.prevYPlane = new Uint8Array(ySize);
      this.prevUPlane = new Uint8Array(uvSize);
      this.prevVPlane = new Uint8Array(uvSize);
      this.currYPlane = new Uint8Array(ySize);
      this.currUPlane = new Uint8Array(uvSize);
      this.currVPlane = new Uint8Array(uvSize);
      if (this.hasYuvAlpha) {
        this.prevAPlane = new Uint8Array(ySize);
        this.currAPlane = new Uint8Array(ySize);
      }
    }
    return this.header;
  }
  readChunkHeader() {
    const chunkType = this.readU8();
    const chunkFlags = this.readU8();
    const chunkSize = this.use32BitChunkSize ? this.readU32() : this.readU16();
    const timestamp = this.readU32();
    let uncompressedSize;
    if (chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) {
      uncompressedSize = this.readU32();
    }
    return { chunkType, chunkFlags, chunkSize, timestamp, uncompressedSize };
  }
  decodeKeyframeData(chunkSize) {
    const dataEnd = this.pos + chunkSize - 8;
    const pixelCount = this.header.width * this.header.height;
    let px = 0;
    this.resetIndex();
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };
    while (px < pixelCount && this.pos < dataEnd) {
      const b1 = this.readU8();
      if (b1 === 254) {
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
      } else if (b1 === 255) {
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
        this.prevPixel.a = this.readU8();
      } else if ((b1 & 192) === 0) {
        const idx = b1 & 63;
        this.prevPixel = { ...this.index[idx] };
      } else if ((b1 & 192) === 64) {
        this.prevPixel.r = this.prevPixel.r + (b1 >> 4 & 3) - 2 & 255;
        this.prevPixel.g = this.prevPixel.g + (b1 >> 2 & 3) - 2 & 255;
        this.prevPixel.b = this.prevPixel.b + (b1 & 3) - 2 & 255;
      } else if ((b1 & 192) === 128) {
        const b2 = this.readU8();
        const dg = (b1 & 63) - 32;
        const dr_dg = (b2 >> 4 & 15) - 8;
        const db_dg = (b2 & 15) - 8;
        this.prevPixel.r = this.prevPixel.r + dg + dr_dg & 255;
        this.prevPixel.g = this.prevPixel.g + dg & 255;
        this.prevPixel.b = this.prevPixel.b + dg + db_dg & 255;
      } else if ((b1 & 192) === 192) {
        const run = (b1 & 63) + 1;
        for (let i = 0; i < run && px < pixelCount; i++) {
          const offset2 = px * 4;
          this.currFrame[offset2] = this.prevPixel.r;
          this.currFrame[offset2 + 1] = this.prevPixel.g;
          this.currFrame[offset2 + 2] = this.prevPixel.b;
          this.currFrame[offset2 + 3] = this.prevPixel.a;
          px++;
        }
        continue;
      }
      this.index[this.colorHash(this.prevPixel)] = { ...this.prevPixel };
      const offset = px * 4;
      this.currFrame[offset] = this.prevPixel.r;
      this.currFrame[offset + 1] = this.prevPixel.g;
      this.currFrame[offset + 2] = this.prevPixel.b;
      this.currFrame[offset + 3] = this.prevPixel.a;
      px++;
    }
    if (px < pixelCount) {
      console.warn(`[Decoder] Keyframe incomplete: decoded ${px}/${pixelCount} pixels, pos=${this.pos}, dataEnd=${dataEnd}`);
    }
    this.pos = this.pos + (dataEnd - this.pos) + 8;
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return px === pixelCount;
  }
  // Decode RGB keyframe from decompressed buffer
  decodeKeyframeDataFromBuffer(uncompressedSize) {
    const dataEnd = uncompressedSize - 8;
    const pixelCount = this.header.width * this.header.height;
    let px = 0;
    this.resetIndex();
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };
    while (px < pixelCount && this.activePos < dataEnd) {
      const b1 = this.readU8();
      if (b1 === 254) {
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
      } else if (b1 === 255) {
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
        this.prevPixel.a = this.readU8();
      } else if ((b1 & 192) === 0) {
        const idx = b1 & 63;
        this.prevPixel = { ...this.index[idx] };
      } else if ((b1 & 192) === 64) {
        this.prevPixel.r = this.prevPixel.r + (b1 >> 4 & 3) - 2 & 255;
        this.prevPixel.g = this.prevPixel.g + (b1 >> 2 & 3) - 2 & 255;
        this.prevPixel.b = this.prevPixel.b + (b1 & 3) - 2 & 255;
      } else if ((b1 & 192) === 128) {
        const b2 = this.readU8();
        const dg = (b1 & 63) - 32;
        const dr_dg = (b2 >> 4 & 15) - 8;
        const db_dg = (b2 & 15) - 8;
        this.prevPixel.r = this.prevPixel.r + dg + dr_dg & 255;
        this.prevPixel.g = this.prevPixel.g + dg & 255;
        this.prevPixel.b = this.prevPixel.b + dg + db_dg & 255;
      } else if ((b1 & 192) === 192) {
        const run = (b1 & 63) + 1;
        for (let i = 0; i < run && px < pixelCount; i++) {
          const offset2 = px * 4;
          this.currFrame[offset2] = this.prevPixel.r;
          this.currFrame[offset2 + 1] = this.prevPixel.g;
          this.currFrame[offset2 + 2] = this.prevPixel.b;
          this.currFrame[offset2 + 3] = this.prevPixel.a;
          px++;
        }
        continue;
      }
      this.index[this.colorHash(this.prevPixel)] = { ...this.prevPixel };
      const offset = px * 4;
      this.currFrame[offset] = this.prevPixel.r;
      this.currFrame[offset + 1] = this.prevPixel.g;
      this.currFrame[offset + 2] = this.prevPixel.b;
      this.currFrame[offset + 3] = this.prevPixel.a;
      px++;
    }
    if (px < pixelCount) {
      console.warn(`[Decoder] Keyframe incomplete: decoded ${px}/${pixelCount} pixels, activePos=${this.activePos}, dataEnd=${dataEnd}`);
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return px === pixelCount;
  }
  // Decode a single YUV plane for keyframe
  decodeYuvPlaneKeyframe(plane, size) {
    let prevVal = 0;
    const index = new Array(64).fill(-1);
    let px = 0;
    while (px < size) {
      const b1 = this.readU8();
      if ((b1 & 192) === 192 && b1 < 254) {
        const run = (b1 & 63) + 1;
        for (let i = 0; i < run && px < size; i++) {
          plane[px++] = prevVal;
        }
      } else if ((b1 & 192) === 0) {
        const idx = b1 & 63;
        prevVal = index[idx];
        if (prevVal === -1) {
          console.error(`[Decoder] YUV keyframe: INDEX(${idx}) read from uninitialized slot! px=${px}, size=${size}`);
          prevVal = 0;
        }
        plane[px++] = prevVal;
        index[idx] = prevVal;
      } else if ((b1 & 192) === 64) {
        const d = (b1 & 15) - 8;
        prevVal = prevVal + d & 255;
        const idx = prevVal * 3 % 64;
        index[idx] = prevVal;
        plane[px++] = prevVal;
      } else if ((b1 & 192) === 128) {
        const d = (b1 & 63) - 32;
        prevVal = prevVal + d & 255;
        const idx = prevVal * 3 % 64;
        index[idx] = prevVal;
        plane[px++] = prevVal;
      } else if (b1 === 254) {
        prevVal = this.readU8();
        const idx = prevVal * 3 % 64;
        index[idx] = prevVal;
        plane[px++] = prevVal;
      } else {
        console.warn(`[Decoder] Unknown YUV keyframe opcode: 0x${b1.toString(16)} at px=${px}`);
        break;
      }
    }
    return px;
  }
  // Decode a single YUV plane for P-frame (temporal)
  decodeYuvPlanePFrame(plane, prevPlane, size) {
    const index = new Array(64).fill(-1);
    let px = 0;
    const startPos = this.pos;
    plane.set(prevPlane);
    while (px < size) {
      const b1 = this.readU8();
      if (b1 === 0) {
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 192) === 192 && b1 < 254) {
        const skip = (b1 & 63) + 1;
        px += skip;
      } else if ((b1 & 192) === 0) {
        const idx = b1 & 63;
        if (index[idx] === -1) {
          console.error(`[Decoder] YUV P-frame: INDEX(${idx}) read from uninitialized slot! px=${px}, size=${size}`);
          index[idx] = 0;
        }
        plane[px++] = index[idx];
        index[idx] = plane[px - 1];
      } else if ((b1 & 192) === 64) {
        const d = (b1 & 15) - 8;
        plane[px] = prevPlane[px] + d & 255;
        const idx = plane[px] * 3 % 64;
        index[idx] = plane[px];
        px++;
      } else if ((b1 & 192) === 128) {
        const d = (b1 & 63) - 32;
        plane[px] = prevPlane[px] + d & 255;
        const idx = plane[px] * 3 % 64;
        index[idx] = plane[px];
        px++;
      } else if (b1 === 254) {
        plane[px] = this.readU8();
        const idx = plane[px] * 3 % 64;
        index[idx] = plane[px];
        px++;
      } else {
        console.warn(`[Decoder] Unknown YUV P-frame opcode: 0x${b1.toString(16)} at px=${px}`);
        break;
      }
    }
    return this.pos - startPos;
  }
  // Convert YUV planes to RGBA frame
  yuvPlanesToRgba() {
    if (!this.currYPlane || !this.currUPlane || !this.currVPlane)
      return;
    const { width, height, colorspace } = this.header;
    const aPlane = this.hasYuvAlpha ? this.currAPlane : null;
    let pixels;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      pixels = yuv420PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      pixels = yuv422PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    } else {
      pixels = yuv444PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    }
    this.currFrame.set(pixels);
  }
  // Decode YUV keyframe
  decodeYuvKeyframeData(chunkSize) {
    const dataEnd = this.pos + chunkSize - 8;
    const { width, height, colorspace } = this.header;
    const ySize = width * height;
    let uvSize;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }
    this.decodeYuvPlaneKeyframe(this.currYPlane, ySize);
    this.decodeYuvPlaneKeyframe(this.currUPlane, uvSize);
    this.decodeYuvPlaneKeyframe(this.currVPlane, uvSize);
    if (this.hasYuvAlpha && this.currAPlane) {
      this.decodeYuvPlaneKeyframe(this.currAPlane, ySize);
    }
    this.pos = dataEnd + 8;
    this.yuvPlanesToRgba();
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return true;
  }
  // Decode YUV keyframe from decompressed buffer
  decodeYuvKeyframeDataFromBuffer(_uncompressedSize) {
    const { width, height, colorspace } = this.header;
    const ySize = width * height;
    let uvSize;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }
    this.decodeYuvPlaneKeyframe(this.currYPlane, ySize);
    this.decodeYuvPlaneKeyframe(this.currUPlane, uvSize);
    this.decodeYuvPlaneKeyframe(this.currVPlane, uvSize);
    if (this.hasYuvAlpha && this.currAPlane) {
      this.decodeYuvPlaneKeyframe(this.currAPlane, ySize);
    }
    this.yuvPlanesToRgba();
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return true;
  }
  // Decode YUV P-frame
  decodeYuvPFrameData(chunkSize) {
    const dataEnd = this.pos + chunkSize - 8;
    const { width, height, colorspace } = this.header;
    const ySize = width * height;
    let uvSize;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }
    this.decodeYuvPlanePFrame(this.currYPlane, this.prevYPlane, ySize);
    this.decodeYuvPlanePFrame(this.currUPlane, this.prevUPlane, uvSize);
    this.decodeYuvPlanePFrame(this.currVPlane, this.prevVPlane, uvSize);
    if (this.hasYuvAlpha && this.currAPlane && this.prevAPlane) {
      this.decodeYuvPlanePFrame(this.currAPlane, this.prevAPlane, ySize);
    }
    this.pos = dataEnd + 8;
    this.yuvPlanesToRgba();
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return true;
  }
  // Decode YUV P-frame from decompressed buffer
  decodeYuvPFrameDataFromBuffer(_uncompressedSize) {
    const { width, height, colorspace } = this.header;
    const ySize = width * height;
    let uvSize;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }
    this.decodeYuvPlanePFrame(this.currYPlane, this.prevYPlane, ySize);
    this.decodeYuvPlanePFrame(this.currUPlane, this.prevUPlane, uvSize);
    this.decodeYuvPlanePFrame(this.currVPlane, this.prevVPlane, uvSize);
    if (this.hasYuvAlpha && this.currAPlane && this.prevAPlane) {
      this.decodeYuvPlanePFrame(this.currAPlane, this.prevAPlane, ySize);
    }
    this.yuvPlanesToRgba();
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return true;
  }
  decodePFrameData(chunkSize, hasMotion) {
    const dataEnd = this.pos + chunkSize - 8;
    const pixelCount = this.header.width * this.header.height;
    if (!hasMotion) {
      this.currFrame.set(this.prevFrame);
    }
    let px = 0;
    let indexOpcodeCount = 0;
    let skipCount = 0, skipLongCount = 0, tdiffCount = 0, tlumaCount = 0, rgbCount = 0, rgbaCount = 0;
    let darkPixels = [];
    while (px < pixelCount && this.pos < dataEnd) {
      const b1 = this.readU8();
      if (b1 === 0) {
        const skip = this.readU16();
        px += skip;
        skipLongCount++;
      } else if ((b1 & 192) === 192 && b1 < 254) {
        const skip = (b1 & 63) + 1;
        px += skip;
        skipCount++;
      } else if ((b1 & 192) === 64) {
        const offset = px * 4;
        this.currFrame[offset] = this.currFrame[offset] + (b1 >> 4 & 3) - 2 & 255;
        this.currFrame[offset + 1] = this.currFrame[offset + 1] + (b1 >> 2 & 3) - 2 & 255;
        this.currFrame[offset + 2] = this.currFrame[offset + 2] + (b1 & 3) - 2 & 255;
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        if (c.r < 20 && c.g < 20 && c.b < 20 && darkPixels.length < 10) {
          darkPixels.push({ px, r: c.r, g: c.g, b: c.b, opcode: "TDIFF" });
        }
        this.index[this.colorHash(c)] = c;
        tdiffCount++;
        px++;
      } else if ((b1 & 192) === 128) {
        const b2 = this.readU8();
        const offset = px * 4;
        const dg = (b1 & 63) - 32;
        const dr_dg = (b2 >> 4 & 15) - 8;
        const db_dg = (b2 & 15) - 8;
        this.currFrame[offset] = this.currFrame[offset] + dg + dr_dg & 255;
        this.currFrame[offset + 1] = this.currFrame[offset + 1] + dg & 255;
        this.currFrame[offset + 2] = this.currFrame[offset + 2] + dg + db_dg & 255;
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        if (c.r < 20 && c.g < 20 && c.b < 20 && darkPixels.length < 10) {
          darkPixels.push({ px, r: c.r, g: c.g, b: c.b, opcode: "TLUMA" });
        }
        this.index[this.colorHash(c)] = c;
        tlumaCount++;
        px++;
      } else if ((b1 & 192) === 0) {
        const idx = b1 & 63;
        const c = this.index[idx];
        const offset = px * 4;
        this.currFrame[offset] = c.r;
        this.currFrame[offset + 1] = c.g;
        this.currFrame[offset + 2] = c.b;
        this.currFrame[offset + 3] = c.a;
        if (c.r < 20 && c.g < 20 && c.b < 20 && darkPixels.length < 10) {
          darkPixels.push({ px, r: c.r, g: c.g, b: c.b, opcode: `INDEX[${idx}]` });
        }
        indexOpcodeCount++;
        px++;
      } else if (b1 === 254) {
        const offset = px * 4;
        this.currFrame[offset] = this.readU8();
        this.currFrame[offset + 1] = this.readU8();
        this.currFrame[offset + 2] = this.readU8();
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        if (c.r < 20 && c.g < 20 && c.b < 20 && darkPixels.length < 10) {
          darkPixels.push({ px, r: c.r, g: c.g, b: c.b, opcode: "RGB" });
        }
        this.index[this.colorHash(c)] = c;
        rgbCount++;
        px++;
      } else if (b1 === 255) {
        const offset = px * 4;
        this.currFrame[offset] = this.readU8();
        this.currFrame[offset + 1] = this.readU8();
        this.currFrame[offset + 2] = this.readU8();
        this.currFrame[offset + 3] = this.readU8();
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        if (c.r < 20 && c.g < 20 && c.b < 20 && darkPixels.length < 10) {
          darkPixels.push({ px, r: c.r, g: c.g, b: c.b, opcode: "RGBA" });
        }
        this.index[this.colorHash(c)] = c;
        rgbaCount++;
        px++;
      }
    }
    const frameNum = this.frameCount || 0;
    if (frameNum < 5) {
      console.log(`[Decoder] P-frame ${frameNum}: SKIP=${skipCount}, SKIP_LONG=${skipLongCount}, TDIFF=${tdiffCount}, TLUMA=${tlumaCount}, RGB=${rgbCount}, RGBA=${rgbaCount}, INDEX=${indexOpcodeCount}`);
      if (darkPixels.length > 0) {
        console.warn(`[Decoder] P-frame ${frameNum} dark pixels:`, darkPixels);
      }
    }
    if (indexOpcodeCount > 0) {
      console.warn(`[Decoder] P-frame had ${indexOpcodeCount} unexpected INDEX opcodes (encoder bug or data corruption)`);
    }
    this.pos = this.pos + (dataEnd - this.pos) + 8;
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    this.frameCount++;
    return true;
  }
  // Decode RGB P-frame from decompressed buffer
  decodePFrameDataFromBuffer(uncompressedSize, hasMotion) {
    const dataEnd = uncompressedSize - 8;
    const pixelCount = this.header.width * this.header.height;
    if (!hasMotion) {
      this.currFrame.set(this.prevFrame);
    }
    let px = 0;
    while (px < pixelCount && this.activePos < dataEnd) {
      const b1 = this.readU8();
      if (b1 === 0) {
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 192) === 192 && b1 < 254) {
        const skip = (b1 & 63) + 1;
        px += skip;
      } else if ((b1 & 192) === 64) {
        const offset = px * 4;
        this.currFrame[offset] = this.currFrame[offset] + (b1 >> 4 & 3) - 2 & 255;
        this.currFrame[offset + 1] = this.currFrame[offset + 1] + (b1 >> 2 & 3) - 2 & 255;
        this.currFrame[offset + 2] = this.currFrame[offset + 2] + (b1 & 3) - 2 & 255;
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 192) === 128) {
        const b2 = this.readU8();
        const offset = px * 4;
        const dg = (b1 & 63) - 32;
        const dr_dg = (b2 >> 4 & 15) - 8;
        const db_dg = (b2 & 15) - 8;
        this.currFrame[offset] = this.currFrame[offset] + dg + dr_dg & 255;
        this.currFrame[offset + 1] = this.currFrame[offset + 1] + dg & 255;
        this.currFrame[offset + 2] = this.currFrame[offset + 2] + dg + db_dg & 255;
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 192) === 0) {
        const idx = b1 & 63;
        const c = this.index[idx];
        const offset = px * 4;
        this.currFrame[offset] = c.r;
        this.currFrame[offset + 1] = c.g;
        this.currFrame[offset + 2] = c.b;
        this.currFrame[offset + 3] = c.a;
        px++;
      } else if (b1 === 254) {
        const offset = px * 4;
        this.currFrame[offset] = this.readU8();
        this.currFrame[offset + 1] = this.readU8();
        this.currFrame[offset + 2] = this.readU8();
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if (b1 === 255) {
        const offset = px * 4;
        this.currFrame[offset] = this.readU8();
        this.currFrame[offset + 1] = this.readU8();
        this.currFrame[offset + 2] = this.readU8();
        this.currFrame[offset + 3] = this.readU8();
        const c = {
          r: this.currFrame[offset],
          g: this.currFrame[offset + 1],
          b: this.currFrame[offset + 2],
          a: this.currFrame[offset + 3]
        };
        this.index[this.colorHash(c)] = c;
        px++;
      }
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
    return true;
  }
  *decodeFrames() {
    if (!this.header) {
      this.decodeHeader();
    }
    this.pos = 24;
    let frameNumber = 0;
    console.log(`[Decoder] Starting frame decode at pos ${this.pos}, file length: ${this.data.length}`);
    while (this.pos < this.data.length) {
      const chunkStartPos = this.pos;
      const chunkHeader = this.readChunkHeader();
      console.log(`[Decoder] Chunk at ${chunkStartPos}: type=0x${chunkHeader.chunkType.toString(16)}, size=${chunkHeader.chunkSize}, timestamp=${chunkHeader.timestamp}`);
      if (this.pos + chunkHeader.chunkSize > this.data.length) {
        console.error(`[Decoder] Chunk size ${chunkHeader.chunkSize} exceeds remaining data (${this.data.length - this.pos} bytes left)`);
        break;
      }
      switch (chunkHeader.chunkType) {
        case QOV_CHUNK_SYNC:
          this.pos += chunkHeader.chunkSize;
          break;
        case QOV_CHUNK_KEYFRAME: {
          const isYuvChunk = (chunkHeader.chunkFlags & 1) !== 0;
          const isCompressed = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
          console.log(`[Decoder] Decoding keyframe ${frameNumber}, YUV: ${isYuvChunk}, Compressed: ${isCompressed}...`);
          let effectiveChunkSize = chunkHeader.chunkSize;
          if (isCompressed) {
            effectiveChunkSize -= 4;
            const compressedData = this.data.subarray(this.pos, this.pos + effectiveChunkSize);
            this.pos += effectiveChunkSize;
            const decompressedData = lz4Decompress(compressedData, chunkHeader.uncompressedSize);
            this.setActiveData(decompressedData);
            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvKeyframeDataFromBuffer(chunkHeader.uncompressedSize);
            } else {
              this.decodeKeyframeDataFromBuffer(chunkHeader.uncompressedSize);
            }
            this.setActiveData(null);
          } else {
            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvKeyframeData(chunkHeader.chunkSize);
            } else {
              this.decodeKeyframeData(chunkHeader.chunkSize);
            }
          }
          yield {
            pixels: new Uint8ClampedArray(this.prevFrame),
            timestamp: chunkHeader.timestamp,
            isKeyframe: true,
            frameNumber: frameNumber++
          };
          break;
        }
        case QOV_CHUNK_PFRAME: {
          const isYuvChunk = (chunkHeader.chunkFlags & 1) !== 0;
          const isCompressed = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
          console.log(`[Decoder] Decoding P-frame ${frameNumber}, YUV: ${isYuvChunk}, Compressed: ${isCompressed}...`);
          let effectiveChunkSize = chunkHeader.chunkSize;
          if (isCompressed) {
            effectiveChunkSize -= 4;
            const compressedData = this.data.subarray(this.pos, this.pos + effectiveChunkSize);
            this.pos += effectiveChunkSize;
            const decompressedData = lz4Decompress(compressedData, chunkHeader.uncompressedSize);
            this.setActiveData(decompressedData);
            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvPFrameDataFromBuffer(chunkHeader.uncompressedSize);
            } else {
              this.decodePFrameDataFromBuffer(chunkHeader.uncompressedSize, (chunkHeader.chunkFlags & 2) !== 0);
            }
            this.setActiveData(null);
          } else {
            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvPFrameData(chunkHeader.chunkSize);
            } else {
              this.decodePFrameData(chunkHeader.chunkSize, (chunkHeader.chunkFlags & 2) !== 0);
            }
          }
          yield {
            pixels: new Uint8ClampedArray(this.prevFrame),
            timestamp: chunkHeader.timestamp,
            isKeyframe: false,
            frameNumber: frameNumber++
          };
          break;
        }
        case QOV_CHUNK_BFRAME:
          this.pos += chunkHeader.chunkSize;
          break;
        case QOV_CHUNK_AUDIO:
          this.pos += chunkHeader.chunkSize;
          break;
        case QOV_CHUNK_INDEX:
          this.pos += chunkHeader.chunkSize;
          break;
        case QOV_CHUNK_END:
          console.log(`[Decoder] Reached END chunk, total frames: ${frameNumber}`);
          return;
        default:
          console.warn(`[Decoder] Unknown chunk type: 0x${chunkHeader.chunkType.toString(16)}`);
          this.pos += chunkHeader.chunkSize;
          break;
      }
    }
    console.log(`[Decoder] Finished, decoded ${frameNumber} frames`);
  }
  getFileStats() {
    if (!this.header) {
      this.decodeHeader();
    }
    const chunks = [];
    const keyframeIndices = [];
    const indexTable = [];
    let frameIndex = 0;
    let lastTimestamp = 0;
    this.pos = 24;
    while (this.pos < this.data.length) {
      const offset = this.pos;
      const chunkHeader = this.readChunkHeader();
      const headerSize = this.use32BitChunkSize ? 10 : 8;
      const isCompressed = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
      const chunkInfo = {
        type: chunkHeader.chunkType,
        typeName: getChunkTypeName(chunkHeader.chunkType),
        offset,
        size: chunkHeader.chunkSize + headerSize,
        timestamp: chunkHeader.timestamp,
        isKeyframe: chunkHeader.chunkType === QOV_CHUNK_KEYFRAME,
        isCompressed,
        uncompressedSize: isCompressed ? chunkHeader.uncompressedSize : void 0
      };
      chunks.push(chunkInfo);
      if (chunkHeader.chunkType === QOV_CHUNK_KEYFRAME) {
        keyframeIndices.push(frameIndex);
        frameIndex++;
      } else if (chunkHeader.chunkType === QOV_CHUNK_PFRAME || chunkHeader.chunkType === QOV_CHUNK_BFRAME) {
        frameIndex++;
      }
      if (chunkHeader.timestamp > lastTimestamp) {
        lastTimestamp = chunkHeader.timestamp;
      }
      if (chunkHeader.chunkType === QOV_CHUNK_INDEX) {
        const entryCount = this.readU32();
        for (let i = 0; i < entryCount; i++) {
          const frameNum = this.readU32();
          const offsetHigh = this.readU32();
          const offsetLow = this.readU32();
          const timestamp = this.readU32();
          indexTable.push({
            frameNum,
            fileOffset: BigInt(offsetHigh) << 32n | BigInt(offsetLow),
            timestamp
          });
        }
      } else if (chunkHeader.chunkType === QOV_CHUNK_END) {
        break;
      } else {
        this.pos += chunkHeader.chunkSize;
      }
    }
    return {
      header: this.header,
      fileSize: this.data.length,
      chunks,
      keyframeIndices,
      indexTable,
      duration: lastTimestamp
    };
  }
  getHeader() {
    if (!this.header) {
      this.decodeHeader();
    }
    return this.header;
  }
};

// diagnose-qov.mjs
function analyzePixels(pixels, width, height, frameNum) {
  let blackPixels = 0;
  let darkPixels = 0;
  let normalPixels = 0;
  const blackLocations = [];
  let minY = 255, maxY = 0;
  let avgY = 0;
  const yHistogram = new Array(256).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const a = pixels[idx + 3];
      const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      avgY += luma;
      minY = Math.min(minY, luma);
      maxY = Math.max(maxY, luma);
      yHistogram[luma]++;
      if (r === 0 && g === 0 && b === 0) {
        blackPixels++;
        if (blackLocations.length < 20) {
          blackLocations.push({ x, y, r, g, b, a });
        }
      } else if (r < 20 && g < 20 && b < 20) {
        darkPixels++;
        if (blackLocations.length < 20) {
          blackLocations.push({ x, y, r, g, b, a });
        }
      } else {
        normalPixels++;
      }
    }
  }
  avgY /= width * height;
  console.log(`
=== Frame ${frameNum} Pixel Analysis ===`);
  console.log(`Black pixels (R=G=B=0): ${blackPixels} (${(blackPixels / (width * height) * 100).toFixed(2)}%)`);
  console.log(`Dark pixels (R,G,B < 20): ${darkPixels} (${(darkPixels / (width * height) * 100).toFixed(2)}%)`);
  console.log(`Normal pixels: ${normalPixels} (${(normalPixels / (width * height) * 100).toFixed(2)}%)`);
  console.log(`Luminance: min=${minY}, max=${maxY}, avg=${avgY.toFixed(1)}`);
  console.log(`
Luminance histogram (0-20):`);
  for (let i = 0; i <= 20; i++) {
    if (yHistogram[i] > 0) {
      console.log(`  Y=${i}: ${yHistogram[i]} pixels`);
    }
  }
  if (blackLocations.length > 0) {
    console.log(`
First ${Math.min(20, blackLocations.length)} black/dark pixel locations:`);
    for (const loc of blackLocations.slice(0, 20)) {
      console.log(`  (${loc.x}, ${loc.y}): R=${loc.r} G=${loc.g} B=${loc.b} A=${loc.a}`);
    }
  }
}
function analyzeYuvPlanes(decoder, frameNum) {
  const yPlane = decoder.prevYPlane || decoder.currYPlane;
  const uPlane = decoder.prevUPlane || decoder.currUPlane;
  const vPlane = decoder.prevVPlane || decoder.currVPlane;
  if (!yPlane || !uPlane || !vPlane) {
    console.log("YUV planes not available");
    return;
  }
  console.log(`
=== Frame ${frameNum} YUV Plane Analysis ===`);
  let yMin = 255, yMax = 0, ySum = 0;
  let yZeroCount = 0;
  const yHistogram = new Array(256).fill(0);
  const yZeroLocations = [];
  for (let i = 0; i < yPlane.length; i++) {
    const y = yPlane[i];
    ySum += y;
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
    yHistogram[y]++;
    if (y === 0) {
      yZeroCount++;
      if (yZeroLocations.length < 10) {
        yZeroLocations.push(i);
      }
    }
  }
  console.log(`Y plane: min=${yMin}, max=${yMax}, avg=${(ySum / yPlane.length).toFixed(1)}, zero count=${yZeroCount}`);
  if (yZeroLocations.length > 0) {
    console.log(`Y plane zero locations (first 10):`);
    for (const idx of yZeroLocations) {
      console.log(`  Y[${idx}] = 0`);
    }
  }
  let uMin = 255, uMax = 0, uSum = 0;
  for (let i = 0; i < uPlane.length; i++) {
    const u = uPlane[i];
    uSum += u;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  console.log(`U plane: min=${uMin}, max=${uMax}, avg=${(uSum / uPlane.length).toFixed(1)}`);
  let vMin = 255, vMax = 0, vSum = 0;
  for (let i = 0; i < vPlane.length; i++) {
    const v = vPlane[i];
    vSum += v;
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  console.log(`V plane: min=${vMin}, max=${vMax}, avg=${(vSum / vPlane.length).toFixed(1)}`);
  console.log(`
Y plane histogram (0-20):`);
  for (let i = 0; i <= 20; i++) {
    if (yHistogram[i] > 0) {
      console.log(`  Y=${i}: ${yHistogram[i]} samples`);
    }
  }
  console.log(`
YUV to RGB conversion tests (using BT.601):`);
  const testValues = [
    { y: 0, u: 128, v: 128, desc: "Y=0, neutral chroma (black)" },
    { y: 1, u: 128, v: 128, desc: "Y=1, neutral chroma (nearly black)" },
    { y: 5, u: 128, v: 128, desc: "Y=5, neutral chroma" },
    { y: 10, u: 128, v: 128, desc: "Y=10, neutral chroma" },
    { y: 16, u: 128, v: 128, desc: "Y=16, neutral chroma (black in limited range)" },
    { y: 0, u: 100, v: 150, desc: "Y=0 with blue/red chroma" },
    { y: 0, u: 150, v: 100, desc: "Y=0 with green/cyan chroma" }
  ];
  for (const { y, u, v, desc } of testValues) {
    const r = Math.round(y + 1.402 * (v - 128));
    const g = Math.round(y - 0.344 * (u - 128) - 0.714 * (v - 128));
    const b = Math.round(y + 1.772 * (u - 128));
    const rClamped = Math.max(0, Math.min(255, r));
    const gClamped = Math.max(0, Math.min(255, g));
    const bClamped = Math.max(0, Math.min(255, b));
    const clampInfo = [];
    if (r !== rClamped) clampInfo.push(`R:${r}->${rClamped}`);
    if (g !== gClamped) clampInfo.push(`G:${g}->${gClamped}`);
    if (b !== bClamped) clampInfo.push(`B:${b}->${bClamped}`);
    const clamped = clampInfo.length > 0 ? ` [CLAMPED: ${clampInfo.join(", ")}]` : "";
    console.log(`  ${desc}`);
    console.log(`    Y=${y} U=${u} V=${v} -> RGB(${rClamped}, ${gClamped}, ${bClamped})${clamped}`);
  }
}
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node diagnose-qov.mjs <path-to-qov-file>");
    process.exit(1);
  }
  console.log(`
Analyzing QOV file: ${filePath}
`);
  const fileData = fs.readFileSync(filePath);
  const data = new Uint8Array(fileData);
  const decoder = new QovDecoder(data);
  const header = decoder.decodeHeader();
  console.log("=== QOV Header ===");
  console.log(`Magic: ${header.magic}`);
  console.log(`Version: 0x${header.version.toString(16)}`);
  console.log(`Dimensions: ${header.width}x${header.height}`);
  console.log(`Frame rate: ${header.frameRateNum}/${header.frameRateDen} = ${(header.frameRateNum / header.frameRateDen).toFixed(2)} fps`);
  console.log(`Total frames: ${header.totalFrames}`);
  console.log(`Flags: 0x${header.flags.toString(16).padStart(2, "0")}`);
  console.log(`  Has alpha: ${(header.flags & 1) !== 0}`);
  console.log(`  Has motion: ${(header.flags & 2) !== 0}`);
  console.log(`  Has index: ${(header.flags & 4) !== 0}`);
  console.log(`Colorspace: 0x${header.colorspace.toString(16)}`);
  const colorspaceNames = {
    0: "sRGB",
    1: "sRGBA",
    16: "YUV420",
    17: "YUV422",
    18: "YUV444",
    19: "YUVA420"
  };
  console.log(`  Name: ${colorspaceNames[header.colorspace] || "Unknown"}`);
  const maxFrames = 5;
  let frameCount = 0;
  console.log(`
Decoding first ${maxFrames} frames...
`);
  for (const frame of decoder.decodeFrames()) {
    console.log(`
${"=".repeat(60)}`);
    console.log(`Frame ${frame.frameNumber}: ${frame.isKeyframe ? "KEYFRAME" : "P-FRAME"}, timestamp=${frame.timestamp}\xB5s`);
    analyzePixels(frame.pixels, header.width, header.height, frame.frameNumber);
    analyzeYuvPlanes(decoder, frame.frameNumber);
    frameCount++;
    if (frameCount >= maxFrames) break;
  }
  console.log(`
${"=".repeat(60)}`);
  console.log("Analysis complete.");
}
main().catch(console.error);
