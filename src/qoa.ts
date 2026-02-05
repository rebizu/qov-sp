
// QOA - Quite OK Audio Implementation
// Based on https://qoaformat.org/

export const QOA_MIN_FILE_SIZE = 16;
export const QOA_MAX_CHANNELS = 8;
export const QOA_SLICE_LEN = 20;
export const QOA_SLICES_PER_FRAME = 256;
export const QOA_FRAME_LEN = QOA_SLICES_PER_FRAME * QOA_SLICE_LEN;
export const QOA_HEADER_SIZE = 8;
export const QOA_MAGIC = 0x716f6166; // 'qoaf'

export interface QoaFrameHeader {
    channels: number;
    samplerate: number;
    samples: number;
    frameSize: number;
}

export interface QoaLms {
    history: Int16Array;
    weights: Int16Array;
}

// LMS history and weights initialization
function createLms(): QoaLms {
    return {
        history: new Int16Array(4),
        weights: new Int16Array(4)
    };
}

// QOA Decoder
export class QoaDecoder {
    public totalSamples = 0;
    public totalFrames = 0;

    // Decoding state per channel
    private lms: QoaLms[] = [];

    constructor() { }

    public decodeFrame(data: Uint8Array): { samples: Float32Array; header: QoaFrameHeader } | null {
        if (data.length < 16) return null; // Too small for frame header + lms

        let p = 0;
        const frameHeader = (data[p++] << 24) | (data[p++] << 16) | (data[p++] << 8) | data[p++];

        // Valid frame header? Usually starts with channels/samplerate info, not magic.
        // QOA File has 'qoaf' then total samples. 
        // QOA Frame starts with 64-bit header: 
        //  num_channels (8), samplerate (24), fsamples (16), frame_size (16)

        // Wait, the specification says:
        // Frame Header (64 bits):
        // num_channels: 8
        // samplerate: 24
        // fsamples: 16 (frame samples usually 5120)
        // frame_size: 16 (bytes)

        // The data passed here might be a chunk payload from QOV.
        // QOV chunks might wrap QOA frames directly.

        const channels = (frameHeader >> 24) & 0xff;
        const samplerate = frameHeader & 0xffffff;

        const fsamples = (data[p++] << 8) | data[p++];
        const frameSize = (data[p++] << 8) | data[p++];

        if (channels === 0 || channels > QOA_MAX_CHANNELS) return null;

        // Reset or Init LMS if needed
        // In QOA, each frame carries its own LMS state, so we reload it.
        this.lms = [];
        for (let c = 0; c < channels; c++) {
            const lms = createLms();
            for (let i = 0; i < 4; i++) {
                const h = (data[p++] << 8) | data[p++];
                lms.history[i] = (h << 16) >> 16; // Sign extend
            }
            for (let i = 0; i < 4; i++) {
                const w = (data[p++] << 8) | data[p++];
                lms.weights[i] = (w << 16) >> 16;
            }
            this.lms.push(lms);
        }

        // Calculate number of slices
        // frame_size = header(8) + lms(channels * 16) + slices * 8
        // slices * 8 = frame_size - 8 - channels * 16
        const dataSize = frameSize - 8 - (channels * 16);
        const numSlices = Math.floor(dataSize / 8);

        // Usually full frame is 256 slices per channel
        // samples = fsamples (usually 5120)

        const outputSamples = new Float32Array(fsamples * channels);
        let sampleIdx = 0;

        for (let s = 0; s < numSlices; s++) {
            for (let c = 0; c < channels; c++) {
                // Read 64-bit slice
                // In JS, read 2x 32-bit or 8 bytes.
                // Slice: scale_factor(4), slices(20*3)
                // 64 bits = 8 bytes

                // Reading Big Endian
                const b0 = data[p++];
                const b1 = data[p++];
                const b2 = data[p++];
                const b3 = data[p++];
                const b4 = data[p++];
                const b5 = data[p++];
                const b6 = data[p++];
                const b7 = data[p++];

                const scalefactor = (b0 >> 4) & 0x0f;

                let slice =
                    (BigInt(b0) << 56n) |
                    (BigInt(b1) << 48n) |
                    (BigInt(b2) << 40n) |
                    (BigInt(b3) << 32n) |
                    (BigInt(b4) << 24n) |
                    (BigInt(b5) << 16n) |
                    (BigInt(b6) << 8n) |
                    BigInt(b7);

                // Weights & History
                const lms = this.lms[c];
                const weights = lms.weights;
                const history = lms.history;

                for (let i = 0; i < 20; i++) {
                    // Extract 3-bit residual from slice
                    // Slices are packed: sf(4) + weights... wait.
                    // Spec: sf(4), q(3)*20 = 4 + 60 = 64 bits.
                    // Correct.

                    // We extract from high to low?
                    // slice layout: 
                    // bits 63-60: sf
                    // bits 59-57: r0
                    // bits 56-54: r1
                    // ...
                    // bits 2-0: r19

                    // Actually, let's use standard order.
                    const ridx = BigInt(19 - i);
                    // (slice >> (ridx * 3)) & 7
                    const quantized = Number((slice >> (ridx * 3n)) & 0x7n);

                    let prediction = 0;
                    for (let k = 0; k < 4; k++) {
                        prediction += weights[k] * history[k];
                    }
                    prediction >>= 13;

                    // Dequantize
                    const dequantized = this.dequantize(quantized, scalefactor);
                    const reconstructed = Math.max(-32768, Math.min(32767, prediction + dequantized));

                    // Update LMS
                    const delta = dequantized; // residual
                    for (let k = 0; k < 4; k++) {
                        weights[k] += (history[k] < 0 ? -delta : delta) >> 4;
                    }

                    // Shift history
                    history[0] = history[1];
                    history[1] = history[2];
                    history[2] = history[3];
                    history[3] = reconstructed;

                    // Store output
                    // Interleaved? usually yes.
                    // s is slice index (typically time), c is channel.
                    // total slice length is 20.
                    // offset = s * QOA_SLICE_LEN + i;
                    // output index = offset * channels + c;

                    if (sampleIdx < fsamples) {
                        // We can calculate index directly
                        const globalSampleIdx = (s * QOA_SLICE_LEN + i) * channels + c;
                        if (globalSampleIdx < outputSamples.length) {
                            outputSamples[globalSampleIdx] = reconstructed / 32768.0;
                        }
                    }
                }
            }
        }

        return {
            samples: outputSamples,
            header: {
                channels,
                samplerate,
                samples: fsamples,
                frameSize
            }
        };
    }

    // Standard QOA Dequantization Table
    // Access via: qoa_dequant_tab[scalefactor][quantized]
    // But usually implemented as table lookups for scale factors
    // Scale factors are 1/root(2) approx?
    // Reciprocal table?

    // From qoa.h:
    // int qoa_dequant_tab[16][8];

    private dequantize(quantized: number, scalefactor: number): number {


        // quantized is 0..7, representing -3..-1, 0, 1..4 ? 
        // Spec: "3-bit scalar quantization... quantized value is an index into a table?"
        // Actually qoa_dequant_tab maps (sf, q) -> residual.

        // Better to use precomputed tables from spec.
        // Since I can't copy paste huge table easily, I will implement formula or small table.
        // The reference decoder uses a table.
        // Recomputing valid table values:

        // Scale factors:
        // 1, 7, 21, 45, 84, 138, 211, 304, 421, 562, 731, 928, 1154, 1411, 1699, 2018
        // Dequantizer:
        // {0.75, -0.75, 2.5, -2.5, 4.5, -4.5, 7, -7} * scale? No.

        // Let's use the standard tables.
        const table = QOA_DEQUANT_TAB[scalefactor];
        return table[quantized];
    }
}

export class QoaEncoder {
    private lms: QoaLms[];

    constructor(private channels: number, private samplerate: number) {
        this.lms = [];
        for (let c = 0; c < channels; c++) {
            this.lms.push(createLms());
        }
        // Initialize weights to standard starting values
        // {0, 0, -1<<13, 1<<14}
        for (let c = 0; c < channels; c++) {
            this.lms[c].weights[0] = 0;
            this.lms[c].weights[1] = 0;
            this.lms[c].weights[2] = -(1 << 13);
            this.lms[c].weights[3] = (1 << 14);
        }
    }

    public encodeFrame(samples: Float32Array): Uint8Array {
        const channels = this.channels;
        const samplesCount = samples.length / channels;
        const frameSamples = samplesCount; // Assuming one frame input

        // Frame header calculation
        // 8 bytes frame header
        // 16 bytes LMS state per channel
        // 8 bytes per slice (20 samples) per channel
        const slicesPerChannel = Math.ceil(samplesCount / QOA_SLICE_LEN);
        const frameSize = 8 + (channels * 16) + (slicesPerChannel * 8 * channels);

        const buffer = new Uint8Array(frameSize);
        const view = new DataView(buffer.buffer);
        let p = 0;

        // Write Frame Header
        view.setUint8(p++, channels);
        view.setUint8(p++, (this.samplerate >> 16) & 0xff);
        view.setUint16(p, this.samplerate & 0xffff); p += 2;
        view.setUint16(p, frameSamples); p += 2; // fsamples
        view.setUint16(p, frameSize); p += 2;

        // Write LMS State
        for (let c = 0; c < channels; c++) {
            const lms = this.lms[c];
            for (let i = 0; i < 4; i++) {
                view.setInt16(p, lms.history[i]); p += 2;
            }
            for (let i = 0; i < 4; i++) {
                view.setInt16(p, lms.weights[i]); p += 2;
            }
        }

        // Encode Slices
        for (let sampleIdx = 0; sampleIdx < samplesCount; sampleIdx += QOA_SLICE_LEN) {
            for (let c = 0; c < channels; c++) {
                const sliceStart = sampleIdx;
                const sliceLen = Math.min(QOA_SLICE_LEN, samplesCount - sliceStart);

                // Find best scale factor
                let bestError = -1n;
                let bestSlice = 0n;
                let bestLmsHistory = new Int16Array(4);
                let bestLmsWeights = new Int16Array(4);

                const lms = this.lms[c];

                // Brute force search all 16 scale factors
                for (let sf = 0; sf < 16; sf++) {
                    // Restore LMS state for calculation
                    const history = new Int16Array(lms.history);
                    const weights = new Int16Array(lms.weights);
                    let currentError = 0n;
                    let currentSlice = BigInt(sf) << 60n; // Scale factor at top bits

                    for (let i = 0; i < sliceLen; i++) {
                        const sIdx = (sliceStart + i) * channels + c;
                        const sample = Math.max(-32768, Math.min(32767, Math.round(samples[sIdx] * 32768)));

                        // Predict
                        let prediction = 0;
                        for (let k = 0; k < 4; k++) prediction += weights[k] * history[k];
                        prediction >>= 13;

                        const residual = sample - prediction;

                        // Quantize using the precomputed dequant table to find best match
                        // Is this correct? 
                        // The dequantizer table maps (scale_factor, quantized_value) -> dequantized_residual.
                        // We want to find quantized_value 'q' such that dequant_tab[sf][q] is closest to 'residual'.

                        let bestDiff = 2147483647;
                        let bestQ = 0;

                        const table = QOA_DEQUANT_TAB[sf];
                        for (let q = 0; q < 8; q++) {
                            const deq = table[q];
                            const diff = Math.abs(residual - deq);
                            if (diff < bestDiff) {
                                bestDiff = diff;
                                bestQ = q;
                            }
                        }

                        const quantized = bestQ;
                        const dequantized = table[bestQ];
                        const reconstructed = Math.max(-32768, Math.min(32767, prediction + dequantized));

                        // Error (LMS error metric)
                        const err = (sample - reconstructed);
                        currentError += BigInt(err * err);

                        // Pack bits
                        // (19-i)*3
                        currentSlice |= BigInt(quantized) << BigInt((19 - i) * 3);

                        // Update LMS
                        const delta = dequantized;
                        for (let k = 0; k < 4; k++) {
                            weights[k] += (history[k] < 0 ? -delta : delta) >> 4;
                        }
                        history[0] = history[1]; history[1] = history[2]; history[2] = history[3]; history[3] = reconstructed;
                    }

                    if (bestError === -1n || currentError < bestError) {
                        bestError = currentError;
                        bestSlice = currentSlice;
                        bestLmsHistory = bestLmsHistory.length === 0 ? new Int16Array(4) : bestLmsHistory; // logic check
                        // Actually need to copy the typed arrays
                        bestLmsHistory = new Int16Array(history);
                        bestLmsWeights = new Int16Array(weights);
                    }
                }

                // Apply best LMS state
                this.lms[c].history = bestLmsHistory;
                this.lms[c].weights = bestLmsWeights;

                // Write slice (Big Endian)
                view.setBigUint64(p, bestSlice); p += 8;
            }
        }

        return buffer;
    }
}

// Precomputed tables (condensed)
const QOA_DEQUANT_TAB = [
    [1, -1, 3, -3, 5, -5, 7, -7],
    [5, -5, 18, -18, 32, -32, 49, -49],
    [16, -16, 53, -53, 95, -95, 147, -147],
    [34, -34, 113, -113, 203, -203, 315, -315],
    [63, -63, 210, -210, 378, -378, 588, -588],
    [104, -104, 345, -345, 621, -621, 966, -966],
    [158, -158, 528, -528, 950, -950, 1477, -1477],
    [228, -228, 760, -760, 1368, -1368, 2128, -2128],
    [316, -316, 1053, -1053, 1895, -1895, 2947, -2947],
    [422, -422, 1405, -1405, 2529, -2529, 3934, -3934],
    [548, -548, 1828, -1828, 3290, -3290, 5117, -5117],
    [696, -696, 2320, -2320, 4176, -4176, 6496, -6496],
    [866, -866, 2885, -2885, 5193, -5193, 8077, -8077],
    [1058, -1058, 3528, -3528, 6349, -6349, 9877, -9877],
    [1274, -1274, 4248, -4248, 7646, -7646, 11894, -11894],
    [1514, -1514, 5045, -5045, 9081, -9081, 14126, -14126]
];

