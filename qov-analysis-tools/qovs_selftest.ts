// QOV-S v2.0 machinery self-test (TS): runs the streaming sender/receiver
// over an in-process lossy wire and asserts the spec section 5/6 behaviours
// the C# loopback suite covers — intact delivery, FEC single-loss repair,
// NACK double-loss recovery, whole-frame loss with refresh-band healing,
// report/RTT flow, and the adaptation ladder mapping.
// Run: npm run selftest
import {
  QovStreamSender,
  QovStreamReceiver,
  QovPacketType,
  parsePacketHeader,
} from '../src/qov-streaming';
import {
  QovPlaybackGate,
  QovAdaptationController,
  PlaybackDecision,
  inspectChunk,
} from '../src/qov-adaptation';
import { QovEncoder } from '../src/qov-encoder';

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok  ${label}`);
  else { failures++; console.log(`FAIL  ${label}`); }
}

interface Sample { header: Uint8Array; chunks: Uint8Array[]; }

function buildSampleStream(frames = 24, width = 160, height = 120, fps = 30, kfInterval = 1000): Sample {
  const flags = 0x04 | 0x10; // HAS_INDEX | INTRA_REFRESH
  const enc = new QovEncoder(width, height, fps, 1, flags, 0x10, true, 50, undefined, 0, 0);
  enc.writeHeader();
  const header = enc.headerBytes();
  const chunks: Uint8Array[] = [];
  enc.onChunk = (chunk) => chunks.push(chunk.slice());
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < frames; n++) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(rand() * 256);
    const ts = Math.round((n * 1e6) / fps);
    if (n % kfInterval === 0) enc.encodeKeyframe(pixels, ts);
    else enc.encodePFrame(pixels, ts);
  }
  return { header, chunks };
}

interface Wire {
  sender: QovStreamSender;
  receiver: QovStreamReceiver;
  controlLines: string[];
}

// Lossy in-process wire: forward sender packets to the receiver, dropping a
// deterministic subset of one video frame. mode 'once' drops first
// transmissions only (NACK retransmits get through); 'always' loses them
// for good (only FEC can repair).
function buildWire(
  fps: number,
  opts: { fec: number; mode: 'none' | 'once' | 'always'; targetFrame: number },
  onDelivered: (chunk: Uint8Array) => void,
): Wire {
  const controlLines: string[] = [];
  const receiver = new QovStreamReceiver(
    (chunk) => onDelivered(chunk),
    (line) => {
      controlLines.push(line);
      sender.handleNack(line); // the control channel feeds NACKs back
    },
    { frameIntervalMs: 1000 / fps },
  );
  receiver.start();

  let suppress: number | null = null;
  const seenOnce = new Set<number>();
  const sender = new QovStreamSender(
    (packet) => {
      const header = parsePacketHeader(packet)!;
      if (header.packetType !== QovPacketType.Video || opts.mode === 'none') {
        receiver.handlePacket(packet);
        return;
      }
      if (header.frameId !== opts.targetFrame) {
        receiver.handlePacket(packet);
        return;
      }
      if (suppress === null) suppress = header.seq;
      const first = !seenOnce.has(header.seq);
      seenOnce.add(header.seq);
      const drop = opts.mode === 'always'
        ? header.seq === suppress
        : first && (header.seq === suppress || header.seq === suppress + 1);
      if (!drop) receiver.handlePacket(packet);
    },
    { fecGroupSize: opts.fec },
  );
  return { sender, receiver, controlLines };
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs)
    await new Promise((r) => setTimeout(r, 10));
  return cond();
}

async function main(): Promise<number> {
  console.log('QOV-S v2.0 TS machinery self-test');

  const sample = buildSampleStream();
  check(sample.chunks.length >= 24, `sample stream: ${sample.chunks.length} chunks, header ${sample.header.length} bytes`);
  check(sample.chunks.some((c) => c.length > 1180), 'sample has a multi-fragment chunk');

  // 1. Intact delivery
  {
    let delivered = 0;
    const wire = buildWire(30, { fec: 4, mode: 'none', targetFrame: 2 }, () => delivered++);
    for (const chunk of sample.chunks) wire.sender.sendChunk(chunk, false);
    const ok = await waitUntil(() => delivered === sample.chunks.length);
    check(ok && wire.receiver.framesDropped === 0,
      `no loss: ${delivered}/${sample.chunks.length} chunks delivered, dropped=${wire.receiver.framesDropped}`);
    const reported = await waitUntil(() => wire.controlLines.some((l) => l.startsWith('REPORT loss=0')));
    check(reported, 'receiver report flows with loss=0');
  }

  // 2. FEC single-loss repair (packet lost forever, NACK retransmits too)
  {
    let delivered = 0;
    const wire = buildWire(30, { fec: 4, mode: 'always', targetFrame: 2 }, () => delivered++);
    for (const chunk of sample.chunks) wire.sender.sendChunk(chunk, false);
    const ok = await waitUntil(() => delivered === sample.chunks.length);
    check(ok && wire.receiver.fecRecoveries === 1,
      `FEC repair: delivered=${delivered}/${sample.chunks.length} recoveries=${wire.receiver.fecRecoveries}`);
  }

  // 3. NACK double-loss recovery (retransmissions pass the filter)
  {
    let delivered = 0;
    const wire = buildWire(30, { fec: 0, mode: 'once', targetFrame: 2 }, () => delivered++);
    for (const chunk of sample.chunks) wire.sender.sendChunk(chunk, false);
    const ok = await waitUntil(() => delivered === sample.chunks.length);
    check(ok && wire.receiver.fecRecoveries === 0 && wire.receiver.nackSent > 0,
      `NACK recovery: delivered=${delivered}/${sample.chunks.length} nacks=${wire.receiver.nackSent}`);
    check(wire.controlLines.some((l) => l.startsWith('NACK seq=')), 'NACK line emitted');
  }

  // 4. Whole-frame loss + refresh-band healing
  {
    const healSample = buildSampleStream(24, 160, 120, 30, 1000); // only frame 0 keyframe
    const gate = new QovPlaybackGate();
    const decisions: PlaybackDecision[] = [];
    let delivered = 0;
    const wire = buildWire(30, { fec: 0, mode: 'always', targetFrame: 5 }, (chunk) => {
      delivered++;
      const info = inspectChunk(chunk);
      decisions.push(gate.onFrameArrived(info.isKeyframe, info.hasRefreshBand));
    });
    wire.receiver.onFrameDropped = (frameId) => { if (frameId === 5) gate.onFrameLost(); };
    for (const chunk of healSample.chunks) wire.sender.sendChunk(chunk, false);
    const ok = await waitUntil(() => !gate.isHealing && delivered >= healSample.chunks.length - 1);
    check(ok, `healing completed (delivered=${delivered}/${healSample.chunks.length - 1})`);
    check(wire.receiver.framesDropped === 1, `whole-frame loss: exactly 1 frame dropped (got ${wire.receiver.framesDropped})`);
    check(!gate.isHealing, 'playback resumed after refresh-band cycle');
    check(decisions.filter((d) => d === PlaybackDecision.Heal).length >= 11, 'healing run over the band cycle');
    check(decisions[decisions.length - 1] === PlaybackDecision.Display, 'final decision is Display');
  }

  // 5. Adaptation ladder mapping
  {
    const c = new QovAdaptationController(60, 0);
    c.onReport(2.5, 20, 200, 33, 0.99);
    check(c.fecGroupSize === 3, 'ladder: loss 2.5% -> FEC 1:3');
    c.onReport(0.3, 20, 200, 33, 0.99);
    check(c.fecGroupSize === 0, 'ladder: loss 0.3% -> FEC off');
    c.onReport(0.2, 20, 200, 33, 0.5);
    check(c.currentQuality === 50, 'ladder: deficit -> quality 50');
    for (let i = 0; i < 3; i++) c.onReport(0.2, 20, 200, 33, 0.99);
    check(c.currentQuality === 60, 'ladder: sustained surplus -> back to 60');
    c.onReport(0, 20, 20, 33, 0.9);
    check(c.frameSkipActive, 'ladder: buffer drain under pressure -> frame skip');
    c.onReport(0, 20, 20, 33, 0.99);
    check(!c.frameSkipActive, 'ladder: healthy channel -> no frame skip');

    let drops = 0;
    const c2 = new QovAdaptationController(60, 0);
    c2.onReferenceDropped = () => drops++;
    c2.onReport(10, 20, 200, 33, 0.8);
    c2.onReport(10, 20, 200, 33, 0.8);
    c2.onReport(10, 20, 200, 33, 0.8);
    check(drops === 1, 'ladder: sustained loss > 8% drops the reference once');

    // downscale rungs: quality floor + sustained deficit -> 256x192
    // letterbox (stage 1), then the 160x120 bottom rung (stage 2) after two
    // more deficit reports; sustained clean surplus lifts them bottom-first
    // before quality climbs
    const c3 = new QovAdaptationController(60, 0);
    const dsEvents: number[] = [];
    c3.onDownscaleStageChanged = (stage) => dsEvents.push(stage);
    for (let i = 0; i < 4; i++) c3.onReport(10, 20, 200, 33, 0.8);
    check(c3.downscaleStage === 1 && c3.downscaleActive && dsEvents[0] === 1 && c3.currentQuality === 20,
      'ladder: quality at floor + sustained deficit -> 256x192 rung on');
    for (let i = 0; i < 2; i++) c3.onReport(10, 20, 200, 33, 0.8);
    check(c3.downscaleStage === 2 && dsEvents[1] === 2,
      'ladder: deficit persists at the floor -> 160x120 bottom rung');
    c3.onReport(0, 20, 200, 33, 0.99);
    c3.onReport(0, 20, 200, 33, 0.99);
    check(c3.downscaleStage === 2, 'rungs stay on during recovery buildup');
    c3.onReport(0, 20, 200, 33, 0.99);
    check(c3.downscaleStage === 1 && c3.currentQuality === 20,
      'ladder: clean surplus lifts the bottom rung first');
    for (let i = 0; i < 3; i++) c3.onReport(0, 20, 200, 33, 0.99);
    check(!c3.downscaleActive && c3.currentQuality === 20,
      'ladder: next surplus lifts 256x192 before quality climbs');
    for (let i = 0; i < 3; i++) c3.onReport(0, 20, 200, 33, 0.99);
    check(c3.currentQuality === 30, 'ladder: quality climbs again after rungs lifted');
  }

  // 6. Audio batching (v2.1): chunks share packets, order is preserved.
  {
    const audioChunk = new Uint8Array(138); // QOA mono frame sized
    const videoChunk = new Uint8Array(3000); // forces 3 fragments
    const sendOrder: string[] = [];
    const delivered: string[] = [];
    let deliveredAudio = 0;

    const receiver = new QovStreamReceiver(
      (chunk, isAudio) => {
        delivered.push((isAudio ? 'a' : 'v') + chunk.length);
        if (isAudio) deliveredAudio++;
      },
      (line) => sender.handleNack(line),
      { frameIntervalMs: 100 },
    );
    receiver.start();
    const sender = new QovStreamSender((packet) => receiver.handlePacket(packet), { fecGroupSize: 0 });

    // 61 audio chunks (one second of speech) interleaved with 4 video chunks
    for (let v = 0; v < 4; v++) {
      for (let a = 0; a < 15; a++) {
        sender.sendChunk(audioChunk, true);
        sendOrder.push('a138');
      }
      sender.sendChunk(videoChunk, false);
      sendOrder.push('v3000');
    }
    sender.sendChunk(audioChunk, true);
    sendOrder.push('a138');
    sender.flushAudioBatch();
    const ok = await waitUntil(() => delivered.length === sendOrder.length);
    check(ok && delivered.length === sendOrder.length,
      `batch delivery: ${delivered.length}/${sendOrder.length} chunks, audio=${deliveredAudio}`);
    check(delivered.every((d, i) => d === sendOrder[i]), 'batch delivery preserves send order exactly');
    check(sender.audioBatchPackets < 61 && sender.audioBatchedChunks === 61,
      `batching: ${sender.audioBatchedChunks} chunks in ${sender.audioBatchPackets} packets`);
    receiver.stop();
  }

  // 7. Lost batch packet: NACK retransmit delivers every chunk in the batch.
  {
    let deliveredAudio = 0;
    let nacks = 0;
    const receiver = new QovStreamReceiver(
      (_chunk, isAudio) => { if (isAudio) deliveredAudio++; },
      (line) => { if (line.startsWith('NACK')) nacks++; sender.handleNack(line); },
      { frameIntervalMs: 100 },
    );
    receiver.start();
    const droppedOnce = new Set<number>();
    const sender = new QovStreamSender(
      (packet) => {
        const h = parsePacketHeader(packet)!;
        if (h.packetType === QovPacketType.AudioBatch && h.seq % 2 === 0 && !droppedOnce.has(h.seq)) {
          droppedOnce.add(h.seq);
          return; // lose the batch once; NACK retransmit gets through
        }
        receiver.handlePacket(packet);
      },
      { fecGroupSize: 0 },
    );
    const audioChunk = new Uint8Array(138);
    for (let i = 0; i < 20; i++) sender.sendChunk(audioChunk, true);
    sender.flushAudioBatch();
    const ok = await waitUntil(() => deliveredAudio === 20);
    check(ok && nacks > 0, `batch NACK recovery: audio=${deliveredAudio}/20 nacks=${nacks}`);
    receiver.stop();
  }

  console.log(failures === 0 ? 'SELF-TEST GREEN' : `SELF-TEST FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
