// QOV-S v2.0 core (qov-streaming-spec.md sections 3-6): 20-byte packetization,
// fragmentation, seq bookkeeping, NACK retransmit, XOR FEC, playback
// deadlines. Carrier-agnostic: the host app provides the media sink
// (sender.onPacket) and the control sink (receiver.sendControl) — WebSocket,
// WebTransport, TCP+UDP, or an in-process queue all work.
export const QOVP_MAGIC = 0x514f5650; // "QOVP"
export const QOVP_VERSION = 0x02;
export const QOVP_HEADER_SIZE = 20;
export const QOV_S_MAX_PACKET = 1200; // datagram-mode cap (spec section 3)
export const QOV_S_MAX_FRAGMENT = QOV_S_MAX_PACKET - QOVP_HEADER_SIZE; // 1180

export enum QovPacketType {
  Video = 0x00,
  Audio = 0x01,
  Fec = 0x02,
  AudioBatch = 0x03, // v2.1: payload is [u16 len][complete AUDIO chunk]...
  KeepAlive = 0xf0,
}

export interface QovPacketFields {
  packetType: QovPacketType;
  seq: number;
  frameId: number;
  fragmentId: number;
  fragmentCount: number;
  payloadSize: number;
}

export function writePacketHeader(buf: Uint8Array, f: QovPacketFields): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(0, QOVP_MAGIC);
  buf[4] = QOVP_VERSION;
  buf[5] = f.packetType;
  dv.setUint32(6, f.seq);
  dv.setUint32(10, f.frameId);
  dv.setUint16(14, f.fragmentId);
  dv.setUint16(16, f.fragmentCount);
  dv.setUint16(18, f.payloadSize);
}

export function parsePacketHeader(bytes: Uint8Array): QovPacketFields | null {
  if (bytes.length < QOVP_HEADER_SIZE) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== QOVP_MAGIC) return null;
  if (bytes[4] !== QOVP_VERSION) return null;
  return {
    packetType: bytes[5] as QovPacketType,
    seq: dv.getUint32(6),
    frameId: dv.getUint32(10),
    fragmentId: dv.getUint16(14),
    fragmentCount: dv.getUint16(16),
    payloadSize: dv.getUint16(18),
  };
}

// ---------------------------------------------------------------- sender

export interface QovStreamSenderOptions {
  fecGroupSize?: number; // 4 = light (default), 3 = aggressive, 0 = off
  replayCapacity?: number; // NACK window, default 1024
  outgoingFilter?: (seq: number, frameId: number, packetType: QovPacketType) => boolean;
  audioBatching?: boolean; // v2.1: consecutive audio chunks share one packet (default true)
}

export class QovStreamSender {
  onPacket: (packet: Uint8Array) => void;
  private fecGroupSize: number;
  private readonly replayCapacity: number;
  private readonly outgoingFilter?: (seq: number, frameId: number, packetType: QovPacketType) => boolean;
  private readonly audioBatching: boolean;
  // v2.1 audio batch accumulation: complete AUDIO chunks waiting to share
  // a datagram ([u16 len][chunk] entries). Flushed full, on any video
  // chunk, or by flushAudioBatch().
  private batchBody: Uint8Array[] = [];
  private batchBytes = 0;
  private batchChunks = 0;
  private readonly replay = new Map<number, Uint8Array>();
  private readonly replayOrder: number[] = [];
  private seq = 0;
  private frameId = 0;
  sentPackets = 0;
  retransmits = 0;
  audioBatchPackets = 0;
  audioBatchedChunks = 0;

  constructor(onPacket: (packet: Uint8Array) => void, opts: QovStreamSenderOptions = {}) {
    this.onPacket = onPacket;
    this.fecGroupSize = opts.fecGroupSize ?? 4;
    this.replayCapacity = opts.replayCapacity ?? 1024;
    this.outgoingFilter = opts.outgoingFilter;
    this.audioBatching = opts.audioBatching ?? true;
  }

  setFecGroupSize(k: number): void { this.fecGroupSize = k; }
  getFecGroupSize(): number { return this.fecGroupSize; }

  // Spec section 3 sender: one QOV chunk -> fragments with a shared
  // frame_id, seq incrementing across all packets; XOR parity per full
  // same-frame group (spec section 5.2).
  // v2.1: audio chunks accumulate into one AudioBatch packet instead —
  // flushed when full, before any video chunk (so batch frame_ids stay
  // below the video's, preserving in-order delivery), or via
  // flushAudioBatch().
  sendChunk(chunk: Uint8Array, isAudio: boolean): void {
    if (isAudio && this.audioBatching) {
      const entry = 2 + chunk.length;
      if (this.batchBytes > 0 && this.batchBytes + entry > QOV_S_MAX_FRAGMENT) this.flushAudioBatch();
      this.batchBody.push(new Uint8Array([chunk.length >> 8, chunk.length & 0xff]));
      this.batchBody.push(chunk);
      this.batchBytes += entry;
      this.batchChunks++;
      if (this.batchBytes >= QOV_S_MAX_FRAGMENT) this.flushAudioBatch();
      return;
    }
    if (!isAudio) this.flushAudioBatch();

    this.frameId++;
    const fragCount = Math.max(1, Math.ceil(chunk.length / QOV_S_MAX_FRAGMENT));
    const type = isAudio ? QovPacketType.Audio : QovPacketType.Video;
    const packets: Uint8Array[] = [];
    const seqs: number[] = [];

    for (let i = 0; i < fragCount; i++) {
      const offset = i * QOV_S_MAX_FRAGMENT;
      const size = Math.min(QOV_S_MAX_FRAGMENT, chunk.length - offset);
      const packet = new Uint8Array(QOVP_HEADER_SIZE + size);
      const seq = ++this.seq;
      writePacketHeader(packet, {
        packetType: type, seq, frameId: this.frameId,
        fragmentId: i, fragmentCount: fragCount, payloadSize: size,
      });
      packet.set(chunk.subarray(offset, offset + size), QOVP_HEADER_SIZE);
      packets.push(packet);
      seqs.push(seq);
      this.remember(seq, packet);
    }

    for (let i = 0; i < packets.length; i++) this.transmit(packets[i], seqs[i], this.frameId, type);

    const k = this.fecGroupSize;
    if (!isAudio && (k === 3 || k === 4)) {
      for (let g = 0; g + k <= packets.length; g += k) {
        let bodyLen = 0;
        for (let i = g; i < g + k; i++) bodyLen = Math.max(bodyLen, packets[i].length);
        const parityBody = new Uint8Array(bodyLen);
        for (let i = g; i < g + k; i++) {
          const p = packets[i];
          for (let b = 0; b < p.length; b++) parityBody[b] ^= p[b];
        }
        const parity = new Uint8Array(QOVP_HEADER_SIZE + bodyLen);
        writePacketHeader(parity, {
          packetType: QovPacketType.Fec, seq: seqs[g], frameId: this.frameId,
          fragmentId: 0, fragmentCount: k, payloadSize: bodyLen,
        });
        parity.set(parityBody, QOVP_HEADER_SIZE);
        this.transmit(parity, seqs[g], this.frameId, QovPacketType.Fec);
      }
    }
  }

  // v2.1 (spec section 3.1): emit accumulated audio chunks as ONE packet —
  // one seq, one frame_id, fragmentCount=1. No FEC parity on batches:
  // audio tolerates loss as gaps, and NACK retransmits the batch whole.
  flushAudioBatch(): void {
    if (this.batchBytes === 0) return;
    const body = new Uint8Array(this.batchBytes);
    let off = 0;
    for (const piece of this.batchBody) { body.set(piece, off); off += piece.length; }
    this.batchBody = [];
    this.batchBytes = 0;
    const chunkCount = this.batchChunks;
    this.batchChunks = 0;

    this.frameId++;
    const packet = new Uint8Array(QOVP_HEADER_SIZE + body.length);
    const seq = ++this.seq;
    writePacketHeader(packet, {
      packetType: QovPacketType.AudioBatch, seq, frameId: this.frameId,
      fragmentId: 0, fragmentCount: 1, payloadSize: body.length,
    });
    packet.set(body, QOVP_HEADER_SIZE);
    this.remember(seq, packet);
    this.transmit(packet, seq, this.frameId, QovPacketType.AudioBatch);
    this.audioBatchPackets++;
    this.audioBatchedChunks += chunkCount;
  }

  // Spec section 5.1: retransmit datagrams still inside the replay window.
  handleNack(line: string): void {
    for (const tok of line.split(/\s+/)) {
      if (!tok.startsWith('seq=')) continue;
      const range = tok.slice(4);
      const dash = range.indexOf('-');
      let from: number, to: number;
      if (dash > 0) {
        from = parseInt(range.slice(0, dash), 10);
        to = parseInt(range.slice(dash + 1), 10);
        if (!(to >= from && to - from <= 1024)) continue;
      } else {
        from = to = parseInt(range, 10);
      }
      for (let s = from; s <= to; s++) {
        const packet = this.replay.get(s);
        if (!packet) continue;
        const header = parsePacketHeader(packet)!;
        this.transmit(packet, header.seq, header.frameId, header.packetType);
        this.retransmits++;
      }
    }
  }

  private transmit(packet: Uint8Array, seq: number, frameId: number, type: QovPacketType): void {
    if (this.outgoingFilter && !this.outgoingFilter(seq, frameId, type)) return;
    this.sentPackets++;
    this.onPacket(packet);
  }

  private remember(seq: number, packet: Uint8Array): void {
    if (this.replay.has(seq)) return;
    this.replay.set(seq, packet);
    this.replayOrder.push(seq);
    while (this.replayOrder.length > this.replayCapacity)
      this.replay.delete(this.replayOrder.shift()!);
  }
}

// -------------------------------------------------------------- receiver

interface FrameReassembly {
  packets: (Uint8Array | null)[];
  packetSeq: number[];
  receivedCount: number;
  fragmentCount: number; // 0 = phantom (expected-missing)
  createdAt: number;
  isAudio: boolean;
  isBatch: boolean; // v2.1 AudioBatch: payload holds [u16 len][chunk] entries
  parities: { payload: Uint8Array; firstSeq: number; groupSize: number }[];
}

export interface QovStreamReceiverOptions {
  frameIntervalMs?: number; // from the QOV header fps; default 100
  deadlineCapMs?: number; // spec section 3: hard cap 100 ms
  nackFlushMs?: number; // coalescing backstop; immediate flush on gap
  reportIntervalMs?: number; // spec section 2.2: every 500 ms
}

// Spec sections 3/5/6 receiver: reassembly, playback deadlines, in-order
// delivery, phantom holes, FEC repair, NACK emit, receiver report.
export class QovStreamReceiver {
  onChunk: (chunk: Uint8Array, isAudio: boolean) => void;
  onFrameDropped: (frameId: number) => void;
  sendControl: (line: string) => void;

  private _frameIntervalMs: number;
  private readonly deadlineCapMs: number;
  private readonly reportIntervalMs: number;
  private readonly pending = new Map<number, FrameReassembly>();
  // video + audio share the sender's frame_id space; all media delivers in
  // frame_id order (spec section 4: audio is independent, but both halves of
  // one sender interleave ids, so ordering them together is well-defined)
  private readonly completedMedia = new Map<number, { chunks: Uint8Array[]; isAudio: boolean }>();
  private readonly receivedSeq = new Set<number>();
  private readonly seqOrder: number[] = [];
  private readonly seqWindow = 4096;
  private readonly nackPending = new Set<number>();
  private nextMediaFrameId = 0;
  private mediaInit = false;
  private resolvedUpTo = 0;
  private highestSeq = 0;
  private contiguous = 0;
  private contiguousMark = 0;
  private seqInit = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private controlTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingAt = 0;
  private lastReportAt = 0;

  framesDelivered = 0;
  framesDropped = 0;
  fecRecoveries = 0;
  nackSent = 0;
  lastRttMs = -1;
  lastReportLoss = 0;

  constructor(
    onChunk: (chunk: Uint8Array, isAudio: boolean) => void,
    sendControl: (line: string) => void,
    opts: QovStreamReceiverOptions = {},
  ) {
    this.onChunk = onChunk;
    this.sendControl = sendControl;
    this._frameIntervalMs = opts.frameIntervalMs ?? 100;
    this.deadlineCapMs = opts.deadlineCapMs ?? 100;
    this.reportIntervalMs = opts.reportIntervalMs ?? 500;
    this.onFrameDropped = () => {};
  }

  get frameIntervalMs(): number { return this._frameIntervalMs; }
  setFrameIntervalMs(ms: number): void {
    this._frameIntervalMs = Math.min(Math.max(ms, 1), 1000);
  }

  start(): void {
    this.stop();
    this.sweepTimer = setInterval(() => this.sweepDeadlines(), 5);
    this.controlTimer = setInterval(() => this.controlTick(), 250);
  }

  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    if (this.controlTimer) { clearInterval(this.controlTimer); this.controlTimer = null; }
  }

  deadline(): number { return Math.min(this.frameIntervalMs, this.deadlineCapMs); }

  handlePacket(bytes: Uint8Array): void {
    const header = parsePacketHeader(bytes);
    if (!header) return;
    if (header.packetType !== QovPacketType.Fec) this.recordSeq(header.seq);

    if (header.packetType === QovPacketType.Fec) {
      this.handleParity(header, bytes);
    } else if (header.packetType === QovPacketType.Video || header.packetType === QovPacketType.Audio) {
      this.handleFragment(header, bytes);
    } else if (header.packetType === QovPacketType.AudioBatch) {
      this.handleFragment(header, bytes);
    }
  }

  private recordSeq(seq: number): void {
    let newGaps = false;
    if (!this.seqInit) {
      this.seqInit = true;
      this.highestSeq = seq;
      this.contiguous = seq;
    } else if (seq > this.highestSeq) {
      for (let s = this.highestSeq + 1; s < seq; s++) {
        if (!this.nackPending.has(s)) { this.nackPending.add(s); newGaps = true; }
      }
      this.highestSeq = seq;
    }
    if (!this.receivedSeq.has(seq)) {
      this.receivedSeq.add(seq);
      this.seqOrder.push(seq);
      while (this.seqOrder.length > this.seqWindow)
        this.receivedSeq.delete(this.seqOrder.shift()!);
      while (this.receivedSeq.has(this.contiguous + 1)) this.contiguous++;
    }
    // Spec section 5.1: NACK immediately on gap detection; the timer is the
    // coalescing backstop.
    if (newGaps) this.flushNack();
  }

  private handleFragment(header: QovPacketFields, packet: Uint8Array): void {
    if (header.frameId === 0) return;
    if (this.mediaInit && header.frameId <= this.resolvedUpTo) return; // late, frame resolved

    // frame_id holes below this packet infer frames whose packets never
    // arrived: track them so the watermark can advance (any media type)
    if (this.mediaInit) {
      for (let f = this.nextMediaFrameId; f < header.frameId; f++) {
        if (!this.pending.has(f) && !this.completedMedia.has(f))
          this.pending.set(f, phantom());
      }
    }

    if (this.completedMedia.has(header.frameId)) return; // dup: already assembled
    let frame = this.pending.get(header.frameId);
    if (!frame) {
      frame = {
        packets: new Array(header.fragmentCount).fill(null),
        packetSeq: new Array(header.fragmentCount).fill(0),
        receivedCount: 0,
        fragmentCount: header.fragmentCount,
        createdAt: nowMs(),
        isAudio: header.packetType !== QovPacketType.Video,
        isBatch: header.packetType === QovPacketType.AudioBatch,
        parities: [],
      };
      this.pending.set(header.frameId, frame);
    } else if (frame.fragmentCount === 0) {
      // phantom upgraded by a real fragment (deadline clock preserved);
      // the phantom carries placeholder types — adopt the real packet's
      frame.fragmentCount = header.fragmentCount;
      frame.packets = new Array(header.fragmentCount).fill(null);
      frame.packetSeq = new Array(header.fragmentCount).fill(0);
      frame.isAudio = header.packetType !== QovPacketType.Video;
      frame.isBatch = header.packetType === QovPacketType.AudioBatch;
    }
    if (header.fragmentId >= frame.fragmentCount) return;

    if (frame.packets[header.fragmentId] === null) {
      frame.packets[header.fragmentId] = packet;
      frame.packetSeq[header.fragmentId] = header.seq;
      frame.receivedCount++;
    }

    if (frame.receivedCount === frame.fragmentCount) {
      this.pending.delete(header.frameId);
      const body = assembleChunk(frame);
      const chunks = frame.isBatch ? splitBatch(body) : [body];
      this.completedMedia.set(header.frameId, { chunks, isAudio: frame.isAudio });
      this.deliverInOrderMedia();
    }
  }

  private handleParity(header: QovPacketFields, packet: Uint8Array): void {
    const frame = this.pending.get(header.frameId);
    if (!frame) return;
    const body = Math.min(header.payloadSize, packet.length - QOVP_HEADER_SIZE);
    frame.parities.push({
      payload: packet.slice(QOVP_HEADER_SIZE, QOVP_HEADER_SIZE + body),
      firstSeq: header.seq,
      groupSize: header.fragmentCount,
    });
  }

  // Spec section 5.2: missing exactly one group member -> reconstruct the
  // full datagram from the parity packet.
  private tryRepair(frame: FrameReassembly): void {
    if (frame.fragmentCount === 0) return;
    for (const { payload, firstSeq, groupSize } of frame.parities) {
      if (payload.length === 0 || groupSize < 2) continue;
      const recon = payload.slice();
      let groupMembers = 0;
      for (let i = 0; i < frame.fragmentCount; i++) {
        const p = frame.packets[i];
        if (!p) continue;
        const s = frame.packetSeq[i];
        if (s >= firstSeq && s < firstSeq + groupSize) {
          groupMembers++;
          for (let b = 0; b < p.length; b++) recon[b] ^= p[b];
        }
      }
      if (groupMembers !== groupSize - 1) continue; // hole not (only) in this group
      const repaired = parsePacketHeader(recon);
      if (!repaired || repaired.fragmentId >= frame.fragmentCount) continue;
      if (frame.packets[repaired.fragmentId] !== null) continue;
      frame.packets[repaired.fragmentId] = recon;
      frame.packetSeq[repaired.fragmentId] = repaired.seq;
      frame.receivedCount++;
      this.fecRecoveries++;
      break; // hole filled; other parities see no hole
    }
  }

  private sweepDeadlines(): void {
    const now = nowMs();
    const dropped: number[] = [];
    for (const [frameId, frame] of [...this.pending]) {
      if (now - frame.createdAt < this.deadline()) continue;

      if (frame.fragmentCount === 0) {
        // expected-missing frame: expire so the watermark advances (spec 6)
        this.pending.delete(frameId);
        this.framesDropped++;
        dropped.push(frameId);
        this.advanceWatermarkOnDrop(frameId);
        continue;
      }

      this.tryRepair(frame);
      this.pending.delete(frameId);
      if (frame.receivedCount === frame.fragmentCount) {
        const body = assembleChunk(frame);
        const chunks = frame.isBatch ? splitBatch(body) : [body];
        this.completedMedia.set(frameId, { chunks, isAudio: frame.isAudio });
      } else {
        this.framesDropped++;
        dropped.push(frameId);
        this.advanceWatermarkOnDrop(frameId);
      }
    }
    // Drop notifications reach the app BEFORE later frames are delivered:
    // the playback gate must be healing while the post-loss frames arrive.
    for (const id of dropped) this.onFrameDropped(id);
    this.deliverInOrderMedia();
  }

  private advanceWatermarkOnDrop(frameId: number): void {
    if (!this.mediaInit) {
      this.mediaInit = true;
      this.nextMediaFrameId = frameId + 1;
    } else if (frameId >= this.nextMediaFrameId) {
      this.nextMediaFrameId = frameId + 1;
    }
    this.resolvedUpTo = Math.max(this.resolvedUpTo, frameId);
  }

  // Spec sections 3/6: media chunks (video and audio) are delivered in
  // frame_id order; a dropped frame advances the watermark so late
  // retransmits are discarded.
  private deliverInOrderMedia(): void {
    if (!this.mediaInit && this.completedMedia.size > 0) {
      this.mediaInit = true;
      this.nextMediaFrameId = Math.min(...this.completedMedia.keys());
    }
    while (this.completedMedia.has(this.nextMediaFrameId)) {
      const entry = this.completedMedia.get(this.nextMediaFrameId)!;
      this.completedMedia.delete(this.nextMediaFrameId);
      this.framesDelivered++;
      for (const chunk of entry.chunks) this.onChunk(chunk, entry.isAudio);
      this.resolvedUpTo = this.nextMediaFrameId;
      this.nextMediaFrameId++;
    }
  }

  private flushNack(): void {
    if (this.nackPending.size === 0) return;
    const missing = [...this.nackPending].sort((a, b) => a - b);
    this.nackPending.clear();
    let line = 'NACK';
    let i = 0;
    while (i < missing.length) {
      const from = missing[i];
      let to = from;
      while (i + 1 < missing.length && missing[i + 1] === to + 1) to = missing[++i];
      line += ` seq=${from}` + (to !== from ? `-${to}` : '');
      i++;
    }
    this.nackSent++;
    this.sendControl(line);
  }

  private controlTick(): void {
    const now = nowMs();
    this.flushNack();
    if (now - this.lastPingAt >= 500) {
      this.lastPingAt = now;
      this.sendControl(`PING t=${Math.round(performance.now() * 1000)}`);
    }
    if (now - this.lastReportAt >= this.reportIntervalMs) {
      this.lastReportAt = now;
      this.sendReport();
    }
  }

  // Spec section 6 receiver report: loss %, RTT, buffer depth, highest
  // contiguous seq — every 500 ms. Loss is measured up to the contiguity
  // watermark so in-flight packets are never counted as lost.
  private sendReport(): void {
    const top = this.contiguous;
    const expected = this.seqInit ? top - this.contiguousMark : 0;
    let missing = 0;
    for (let s = this.contiguousMark + 1; s <= top; s++)
      if (!this.receivedSeq.has(s)) missing++;
    const loss = expected > 0 ? (missing * 100) / expected : 0;
    this.contiguousMark = top;
    this.lastReportLoss = loss;
    const rttUs = this.lastRttMs > 0 ? Math.round(this.lastRttMs * 1000) : 0;
    const bufMs = Math.round(this.pending.size * this.frameIntervalMs);
    this.sendControl(`REPORT loss=${Math.round(loss)} rtt=${rttUs} buf=${bufMs} since=${top}`);
  }

  handlePong(line: string): void {
    const m = /t=(\d+)/.exec(line);
    if (m) this.lastRttMs = (performance.now() * 1000 - parseInt(m[1], 10)) / 1000;
  }
}

function phantom(): FrameReassembly {
  return {
    packets: [], packetSeq: [], receivedCount: 0, fragmentCount: 0,
    createdAt: nowMs(), isAudio: false, isBatch: false, parities: [],
  };
}

// v2.1: walk [u16 len][chunk bytes] entries of an AudioBatch payload.
// Truncated trailing bytes (corrupt packet) are dropped silently: the
// entry length always bounds the read.
function splitBatch(body: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let off = 0;
  while (off + 2 <= body.length) {
    const len = (body[off] << 8) | body[off + 1];
    if (off + 2 + len > body.length) break;
    chunks.push(body.subarray(off + 2, off + 2 + len));
    off += 2 + len;
  }
  return chunks;
}

function assembleChunk(frame: FrameReassembly): Uint8Array {
  let total = 0;
  for (let i = 0; i < frame.fragmentCount; i++) {
    const p = frame.packets[i]!;
    total += parsePacketHeader(p)!.payloadSize;
  }
  const chunk = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < frame.fragmentCount; i++) {
    const p = frame.packets[i]!;
    const size = parsePacketHeader(p)!.payloadSize;
    chunk.set(p.subarray(QOVP_HEADER_SIZE, QOVP_HEADER_SIZE + size), offset);
    offset += size;
  }
  return chunk;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
