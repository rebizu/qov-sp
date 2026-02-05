#!/usr/bin/env node
// Diagnostic tool to analyze QOV files for black dot artifacts
import * as fs from 'fs';
import { QovDecoder } from '../../src/qov-decoder';
function analyzePixels(pixels, width, height, frameNum) {
    let blackPixels = 0;
    let darkPixels = 0;
    let normalPixels = 0;
    const blackLocations = [];
    let minY = 255, maxY = 0;
    let avgY = 0;
    let yHistogram = new Array(256).fill(0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const a = pixels[idx + 3];
            // Calculate luminance (approximate Y value)
            const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            avgY += luma;
            minY = Math.min(minY, luma);
            maxY = Math.max(maxY, luma);
            yHistogram[luma]++;
            // Classify pixels
            if (r === 0 && g === 0 && b === 0) {
                blackPixels++;
                if (blackLocations.length < 20) {
                    blackLocations.push({ x, y, r, g, b, a });
                }
            }
            else if (r < 20 && g < 20 && b < 20) {
                darkPixels++;
                if (blackLocations.length < 20) {
                    blackLocations.push({ x, y, r, g, b, a });
                }
            }
            else {
                normalPixels++;
            }
        }
    }
    avgY /= (width * height);
    console.log(`\n=== Frame ${frameNum} Pixel Analysis ===`);
    console.log(`Black pixels (R=G=B=0): ${blackPixels} (${(blackPixels / (width * height) * 100).toFixed(2)}%)`);
    console.log(`Dark pixels (R,G,B < 20): ${darkPixels} (${(darkPixels / (width * height) * 100).toFixed(2)}%)`);
    console.log(`Normal pixels: ${normalPixels} (${(normalPixels / (width * height) * 100).toFixed(2)}%)`);
    console.log(`Luminance: min=${minY}, max=${maxY}, avg=${avgY.toFixed(1)}`);
    // Show Y histogram for very dark values
    console.log(`\nLuminance histogram (0-20):`);
    for (let i = 0; i <= 20; i++) {
        if (yHistogram[i] > 0) {
            console.log(`  Y=${i}: ${yHistogram[i]} pixels`);
        }
    }
    if (blackLocations.length > 0) {
        console.log(`\nFirst ${Math.min(20, blackLocations.length)} black/dark pixel locations:`);
        for (const loc of blackLocations.slice(0, 20)) {
            console.log(`  (${loc.x}, ${loc.y}): R=${loc.r} G=${loc.g} B=${loc.b} A=${loc.a}`);
        }
    }
}
function analyzeYuvPlanes(decoder, frameNum) {
    // Access internal YUV planes if available
    const yPlane = decoder.prevYPlane || decoder.currYPlane;
    const uPlane = decoder.prevUPlane || decoder.currUPlane;
    const vPlane = decoder.prevVPlane || decoder.currVPlane;
    if (!yPlane || !uPlane || !vPlane) {
        console.log('YUV planes not available');
        return;
    }
    console.log(`\n=== Frame ${frameNum} YUV Plane Analysis ===`);
    // Analyze Y plane
    let yMin = 255, yMax = 0, ySum = 0;
    let yZeroCount = 0;
    const yHistogram = new Array(256).fill(0);
    for (let i = 0; i < yPlane.length; i++) {
        const y = yPlane[i];
        ySum += y;
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
        yHistogram[y]++;
        if (y === 0)
            yZeroCount++;
    }
    console.log(`Y plane: min=${yMin}, max=${yMax}, avg=${(ySum / yPlane.length).toFixed(1)}, zero count=${yZeroCount}`);
    // Analyze U plane
    let uMin = 255, uMax = 0, uSum = 0;
    for (let i = 0; i < uPlane.length; i++) {
        const u = uPlane[i];
        uSum += u;
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
    }
    console.log(`U plane: min=${uMin}, max=${uMax}, avg=${(uSum / uPlane.length).toFixed(1)}`);
    // Analyze V plane
    let vMin = 255, vMax = 0, vSum = 0;
    for (let i = 0; i < vPlane.length; i++) {
        const v = vPlane[i];
        vSum += v;
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
    }
    console.log(`V plane: min=${vMin}, max=${vMax}, avg=${(vSum / vPlane.length).toFixed(1)}`);
    // Show Y histogram for very dark values
    console.log(`\nY plane histogram (0-20):`);
    for (let i = 0; i <= 20; i++) {
        if (yHistogram[i] > 0) {
            console.log(`  Y=${i}: ${yHistogram[i]} samples`);
        }
    }
    // Test YUV to RGB conversion for some dark values
    console.log(`\nYUV to RGB conversion tests (using BT.601):`);
    const testValues = [
        { y: 0, u: 128, v: 128 },
        { y: 1, u: 128, v: 128 },
        { y: 5, u: 128, v: 128 },
        { y: 10, u: 128, v: 128 },
        { y: 16, u: 128, v: 128 },
        { y: 0, u: 100, v: 150 },
        { y: 0, u: 150, v: 100 },
    ];
    for (const { y, u, v } of testValues) {
        // BT.601 conversion
        const r = Math.round(y + 1.402 * (v - 128));
        const g = Math.round(y - 0.344 * (u - 128) - 0.714 * (v - 128));
        const b = Math.round(y + 1.772 * (u - 128));
        const rClamped = Math.max(0, Math.min(255, r));
        const gClamped = Math.max(0, Math.min(255, g));
        const bClamped = Math.max(0, Math.min(255, b));
        const clamped = r !== rClamped || g !== gClamped || b !== bClamped ? ' (CLAMPED)' : '';
        console.log(`  Y=${y} U=${u} V=${v} -> R=${r} G=${g} B=${b} -> R=${rClamped} G=${gClamped} B=${bClamped}${clamped}`);
    }
}
async function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Usage: ts-node diagnose-qov.ts <path-to-qov-file>');
        process.exit(1);
    }
    console.log(`\nAnalyzing QOV file: ${filePath}\n`);
    const fileData = fs.readFileSync(filePath);
    const data = new Uint8Array(fileData);
    const decoder = new QovDecoder(data);
    const header = decoder.decodeHeader();
    console.log('=== QOV Header ===');
    console.log(`Magic: ${header.magic}`);
    console.log(`Version: 0x${header.version.toString(16)}`);
    console.log(`Dimensions: ${header.width}x${header.height}`);
    console.log(`Frame rate: ${header.frameRateNum}/${header.frameRateDen} = ${(header.frameRateNum / header.frameRateDen).toFixed(2)} fps`);
    console.log(`Total frames: ${header.totalFrames}`);
    console.log(`Flags: 0x${header.flags.toString(16).padStart(2, '0')}`);
    console.log(`  Has alpha: ${(header.flags & 0x01) !== 0}`);
    console.log(`  Has motion: ${(header.flags & 0x02) !== 0}`);
    console.log(`  Has index: ${(header.flags & 0x04) !== 0}`);
    console.log(`Colorspace: 0x${header.colorspace.toString(16)}`);
    const colorspaceNames = {
        0x00: 'sRGB',
        0x01: 'sRGBA',
        0x10: 'YUV420',
        0x11: 'YUV422',
        0x12: 'YUV444',
        0x13: 'YUVA420',
    };
    console.log(`  Name: ${colorspaceNames[header.colorspace] || 'Unknown'}`);
    // Decode first few frames
    const maxFrames = 5;
    let frameCount = 0;
    console.log(`\nDecoding first ${maxFrames} frames...\n`);
    for (const frame of decoder.decodeFrames()) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Frame ${frame.frameNumber}: ${frame.isKeyframe ? 'KEYFRAME' : 'P-FRAME'}, timestamp=${frame.timestamp}µs`);
        // Analyze pixels
        analyzePixels(frame.pixels, header.width, header.height, frame.frameNumber);
        // Analyze YUV planes if available
        analyzeYuvPlanes(decoder, frame.frameNumber);
        frameCount++;
        if (frameCount >= maxFrames)
            break;
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log('Analysis complete.');
}
main().catch(console.error);
