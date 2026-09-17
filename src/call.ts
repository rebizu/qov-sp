// QOV-S v2.0 demo: 1:1 call over the WebSocket binding (qov-streaming-spec.md
// sections 1.2/7) with the full feedback->knob loop visible in the UI.
//
// Host: camera -> QOV encode (quality driven by the adaptation ladder) ->
// QOV-S sender -> relay. Guest: relay -> simulated datagram loss ->
// QOV-S receiver -> streaming decoder, gated by the playback gate
// (freeze last good frame, heal over refresh bands) -> REPORTs back.
import { QovEncoder } from './qov-encoder';
import { QoaDecoder } from './qoa';
import { QOV_AUDIO_RATE_SPEECH, QOV_CHUNK_AUDIO_FLAG_OPUS } from './qov-types';
import { QovStreamSender, QovStreamReceiver } from './qov-streaming';
import { QovPlaybackGate, QovAdaptationController, PlaybackDecision, inspectChunk, QOV_DOWNSCALE_STAGES } from './qov-adaptation';
import { QovStreamingDecoder, StreamDataSource } from './qov-streaming-decoder';

const WIDTH = 320, HEIGHT = 240;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const badge = (el: HTMLElement, cls: string, text: string) => { el.className = `badge ${cls}`; el.textContent = text; };

function log(el: HTMLElement, msg: string): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  el.prepend(line);
  while (el.childElementCount > 60) el.lastChild?.remove();
}

function fmtStats(pairs: [string, string | number][]): string {
  return pairs.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}

// ------------------------------------------------------------- transport

// QOV-S section 1.1 defines the session against two abstract channels
// (reliable control, datagram media); a carrier maps them onto a concrete
// transport. The demo ships two: the WebSocket relay and WebRTC
// DataChannels (works from any static site).
interface Carrier {
  onText: (line: string) => void;
  onBinary: (bytes: Uint8Array) => void;
  onOpen: () => void;
  sendText(line: string): void;
  sendBinary(bytes: Uint8Array): void;
}

class Relay implements Carrier {
  ws: WebSocket | null = null;
  onText: (line: string) => void = () => {};
  onBinary: (bytes: Uint8Array) => void = () => {};
  onOpen: () => void = () => {};

  connect(url: string, room: string, stateEl: HTMLElement): void {
    // role switches re-enter join(); a live socket is already in the room
    // and a second JOIN from the same tab would trip the relay's room limit
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    badge(stateEl, 'waiting', 'relay: connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ws.send(`JOIN ${room}`); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // WAIT: partner not here yet. READY: partner already waiting.
        // PEER_JOINED: we were first and the partner just arrived. Any of
        // them means the relay path is up — (re)start the session.
        if (ev.data === 'READY' || ev.data === 'PEER_JOINED' || ev.data === 'WAIT') {
          badge(stateEl, 'live', `relay: ${room}`);
          this.onOpen();
        } else this.onText(ev.data);
        return;
      }
      this.onBinary(new Uint8Array(ev.data));
    };
    ws.onclose = () => badge(stateEl, 'off', 'relay: disconnected');
    ws.onerror = () => badge(stateEl, 'off', 'relay: error');
  }

  sendText(line: string): void { this.ws?.send(line); }
  sendBinary(bytes: Uint8Array): void { this.ws?.send(bytes); }
}

// --- WebRTC DataChannel carrier (spec v2.2 section 7) ----------------------
//
// Control lines ride a reliable ordered DataChannel; QOV-S datagrams ride an
// unordered lossy one (maxRetransmits: 0), mirroring the classic TCP+UDP
// split. Signaling is out-of-band by design: the host and guest exchange
// copy-paste invite/answer codes through any channel they trust, so the call
// works from a fully static site with no server component.

function encodeSignal(d: RTCSessionDescription): string {
  const json = JSON.stringify({ t: d.type, s: d.sdp });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

// to-base64 with URL-safe alphabet so codes survive inside links
function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromUrlSafe(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return b + '='.repeat((4 - (b.length % 4)) % 4);
}

function shareLink(kind: 'invite' | 'answer', code: string): string {
  return `${location.origin}${location.pathname}#${kind}=${toUrlSafe(code)}`;
}

// accepts a raw code or a full share link, in either field
function parseSignalInput(value: string): { kind: 'invite' | 'answer' | null; code: string } {
  const m = /#(?:invite|answer)=([A-Za-z0-9_-]+)/.exec(value.trim());
  if (m) {
    const isAnswer = value.includes('#answer=');
    return { kind: isAnswer ? 'answer' : 'invite', code: fromUrlSafe(m[1]) };
  }
  return { kind: null, code: value.trim() };
}

function decodeSignal(code: string): RTCSessionDescriptionInit {
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(code), (c) => c.charCodeAt(0)));
  const j = JSON.parse(json) as { t: RTCSdpType; s: string };
  return { type: j.t, sdp: j.s };
}

class WebRtcCarrier implements Carrier {
  onText: (line: string) => void = () => {};
  onBinary: (bytes: Uint8Array) => void = () => {};
  onOpen: () => void = () => {};
  private pc: RTCPeerConnection | null = null;
  private ctrl: RTCDataChannel | null = null;
  private media: RTCDataChannel | null = null;
  private opened = false;
  private stateEl: HTMLElement | null = null;

  private wireDc(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onText(ev.data);
      else this.onBinary(new Uint8Array(ev.data));
    };
    dc.onopen = () => {
      if (this.ctrl?.readyState === 'open' && this.media?.readyState === 'open' && !this.opened) {
        this.opened = true;
        badge(this.stateEl!, 'live', 'p2p: connected');
        this.onOpen();
      }
    };
    dc.onclose = () => badge(this.stateEl!, 'off', 'p2p: disconnected');
  }

  private makePc(stateEl: HTMLElement): RTCPeerConnection {
    this.stateEl = stateEl;
    badge(stateEl, 'waiting', 'p2p: gathering…');
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') badge(stateEl, 'off', 'p2p: connection failed (NAT? try the relay)');
    };
    return pc;
  }

  private async gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') done();
      });
      setTimeout(done, 3000); // fall back to whatever candidates we have
    });
  }

  // Host: create the offer (invite code)
  async createInvite(stateEl: HTMLElement): Promise<string> {
    const pc = this.makePc(stateEl);
    this.ctrl = pc.createDataChannel('qovs-ctrl', { ordered: true });
    this.wireDc(this.ctrl);
    this.media = pc.createDataChannel('qovs-media', { ordered: false, maxRetransmits: 0 });
    this.wireDc(this.media);
    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered(pc);
    return encodeSignal(pc.localDescription!);
  }

  // Host: apply the guest's answer code
  async acceptAnswer(code: string): Promise<void> {
    if (!this.pc) throw new Error('create the invite first');
    await this.pc.setRemoteDescription(decodeSignal(code));
  }

  // Guest: apply the host's invite code, produce the answer code
  async acceptInvite(code: string, stateEl: HTMLElement): Promise<string> {
    const pc = this.makePc(stateEl);
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'qovs-ctrl') { this.ctrl = ev.channel; this.wireDc(this.ctrl); }
      else if (ev.channel.label === 'qovs-media') { this.media = ev.channel; this.wireDc(this.media); }
    };
    await pc.setRemoteDescription(decodeSignal(code));
    await pc.setLocalDescription(await pc.createAnswer());
    await this.gathered(pc);
    return encodeSignal(pc.localDescription!);
  }

  // drops instead of throwing when the channel closed (the guest's control
  // timer keeps ticking after a disconnect — that must stay harmless)
  sendText(line: string): void {
    try { if (this.ctrl?.readyState === 'open') this.ctrl.send(line); } catch { /* closed */ }
  }
  sendBinary(bytes: Uint8Array<ArrayBuffer>): void {
    try { if (this.media?.readyState === 'open') this.media.send(bytes); } catch { /* closed */ }
  }
}

// ------------------------------------------------------------------ host

class Host {
  private relay: Carrier;
  private started = false;
  // transports are hot-swappable (relay <-> peer-to-peer)
  rebind(carrier: Carrier): void { this.relay = carrier; }
  private enc!: QovEncoder; // created synchronously in start() before any network event
  private sender: QovStreamSender;
  private controller = new QovAdaptationController(60);
  private captureCanvas = document.createElement('canvas');
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private captureCtx: CanvasRenderingContext2D;
  private running = false;
  private frameCount = 0;
  private framesSinceKf = 0;
  private forceKeyframe = true;
  private lastKeyframeRequestAt = 0;
  private bytesThisSecond = 0;
  private bitrateKbps = 0;
  private skipCount = 0;
  private dropRefCount = 0;
  private downscaleCount = 0;

  constructor(relay: Carrier, private logEl: HTMLElement) {
    this.relay = relay;
    this.sender = new QovStreamSender((packet) => this.relay.sendBinary(packet));
    this.controller.onQualityChanged = (q) => {
      this.enc.setQuality(q);
      log(this.logEl, `knob: setQuality(${q})`);
    };
    this.controller.onReferenceDropped = () => {
      this.enc.dropReference();
      this.dropRefCount++;
      log(this.logEl, 'knob: dropReference() — next P-frame re-keys');
    };
    this.controller.onDownscaleStageChanged = (stage) => {
      if (stage > 0) this.downscaleCount++;
      const s = QOV_DOWNSCALE_STAGES[stage - 1];
      log(this.logEl, stage > 0
        ? `knob: downscale stage ${stage} ON — camera letterboxed to ${s.w}x${s.h}, borders are pure skips`
        : 'knob: downscale OFF — full 320x240 restored');
    };

    this.video = $('cam') as HTMLVideoElement;
    this.captureCanvas.width = WIDTH;
    this.captureCanvas.height = HEIGHT;
    this.captureCtx = this.captureCanvas.getContext('2d', { willReadFrequently: true })!;
    ($('fecSelect') as HTMLSelectElement).onchange = () => this.applyFec();
    setInterval(() => this.tickSecond(), 1000);
  }

  // The encoder (and therefore the QOV header) must exist before the guest's
  // HELLO is answered, so it is created synchronously at Host start — the
  // mic decision is read from the checkbox at that moment.
  private initEncoder(withMic: boolean): void {
    this.enc = new QovEncoder(WIDTH, HEIGHT, 24, 1, 0x04 | 0x10, 0x10, true, 60, undefined,
      withMic ? 1 : 0, withMic ? QOV_AUDIO_RATE_SPEECH : 0,
      // v3.8 range coding + v3.9 structured P-frames: host and guest ship
      // together in this demo, so both always advertise support
      true, true);
    this.enc.writeHeader();
    this.enc.onChunk = (chunk) => {
      this.bytesThisSecond += chunk.length;
      this.sender.sendChunk(chunk, chunk[0] === 0x10);
    };
  }

  private audioFrames = 0;
  private audioSuppressed = 0;

  // Silence gating (DTX-style): windows quieter than this are suppressed at
  // chunk level. ~-48 dBFS sits under browser AGC noise floors.
  private static readonly DTX_RMS_THRESHOLD = 0.004;
  // At least one chunk per this many 20 ms windows (~400 ms) keeps liveness
  // stats and the guest's jitter chain honest during long silences.
  private static readonly DTX_KEEPALIVE_WINDOWS = 20;

  // Speech capture (spec section 5.3): 16 kHz mono frames cut from the
  // browser's audio processing chain (echo cancellation / noise suppression
  // / AGC via getUserMedia constraints — product scope, not format).
  // Codec is QOA by default; Opus uses the platform WebCodecs encoder and
  // the alternate-codec passthrough (spec 5.3 flag 0x01), falling back to
  // QOA where WebCodecs is unavailable.
  private async startMic(): Promise<void> {
    const codec = ($('audioCodecSelect') as HTMLSelectElement).value;
    const astream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const actx = new AudioContext({ sampleRate: QOV_AUDIO_RATE_SPEECH });
    await actx.resume();
    const src = actx.createMediaStreamSource(astream);
    const proc = actx.createScriptProcessor(1024, 1, 1);
    const sink = actx.createGain();
    sink.gain.value = 0; // ScriptProcessor only fires when routed to a destination
    if (codec === 'opus' && typeof AudioEncoder !== 'undefined') {
      const dtx = ($('dtxCheck') as HTMLInputElement).checked;
      // One RMS value per fed 20 ms window; the encoder outputs exactly one
      // packet per fed frame, so shifting here aligns window -> packet.
      const rmsQueue: number[] = [];
      let silentRun = 0;
      const enc = new AudioEncoder({
        output: (chunk) => {
          if (!this.running || !this.enc) return;
          const rms = rmsQueue.shift();
          const silent = rms !== undefined && rms < Host.DTX_RMS_THRESHOLD;
          silentRun = silent ? silentRun + 1 : 0;
          if (dtx && silent && silentRun % Host.DTX_KEEPALIVE_WINDOWS !== 0) {
            this.audioSuppressed++;
            return;
          }
          const packet = new Uint8Array(chunk.byteLength);
          chunk.copyTo(packet);
          this.enc.encodeAudioOpus(packet, chunk.timestamp);
          this.audioFrames++;
        },
        error: (e) => log(this.logEl, `opus encoder error: ${e.message} — audio stopped`),
      });
      enc.configure({
        codec: 'opus', sampleRate: QOV_AUDIO_RATE_SPEECH, numberOfChannels: 1, bitrate: 24000,
      });
      const opusPending: number[] = [];
      proc.onaudioprocess = (e) => {
        if (!this.running) return;
        const input = e.inputBuffer.getChannelData(0);
        for (const v of input) opusPending.push(v);
        while (opusPending.length >= 320) { // one 20 ms Opus frame at 16 kHz
          const data = new Float32Array(opusPending.splice(0, 320));
          let sum = 0;
          for (let i = 0; i < 320; i++) sum += data[i] * data[i];
          rmsQueue.push(Math.sqrt(sum / 320));
          const ad = new AudioData({
            format: 'f32-planar', sampleRate: QOV_AUDIO_RATE_SPEECH,
            numberOfFrames: 320, numberOfChannels: 1, timestamp: Math.round(performance.now() * 1000),
            data,
          });
          enc.encode(ad);
          ad.close();
        }
      };
      log(this.logEl, `microphone open (${actx.sampleRate} Hz mono, browser AEC/NS/AGC, Opus ~24 kbps` +
        (dtx ? `; silence suppression on, keep-alive ~400 ms` : ``) + `)`);
    } else {
      if (codec === 'opus') log(this.logEl, 'WebCodecs AudioEncoder unavailable — using QOA');
      const pending: number[] = [];
      proc.onaudioprocess = (e) => {
        if (!this.running || !this.enc) return;
        for (const v of e.inputBuffer.getChannelData(0)) pending.push(v);
        while (pending.length >= 256) {
          const frame = new Float32Array(pending.splice(0, 256));
          this.enc.encodeAudio(frame, Math.round(performance.now() * 1000));
          this.audioFrames++;
        }
      };
      log(this.logEl, `microphone open (${actx.sampleRate} Hz mono, browser AEC/NS/AGC, QOA 69 kbps)`);
    }
    src.connect(proc);
    proc.connect(sink);
    sink.connect(actx.destination);
  }

  get fps(): number { return parseInt(($('fpsSlider') as HTMLInputElement).value, 10); }

  // The combobox is the operator's ceiling: "off" forces FEC off entirely,
  // otherwise the ladder modulates between 1:4 / 1:3 / off per report.
  applyFec(): void {
    const mode = ($('fecSelect') as HTMLSelectElement).value;
    this.sender.setFecGroupSize(mode === '0' ? 0 : this.controller.fecGroupSize || (mode === '3' ? 3 : 4));
  }

  private synthetic = false;
  private previewTimer: number | null = null;

  async start(withMic: boolean): Promise<void> {
    if (this.started) return; // carrier switches re-enter start(); camera opens once
    this.started = true;
    if (!this.enc) this.initEncoder(withMic); // ensureSession() may have created it already
    if (withMic) await this.startMic().catch((e) => log(this.logEl, `mic error: ${(e as Error).message}`));
    await this.openCamera();
  }

  async openCamera(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: WIDTH, height: HEIGHT, frameRate: 30 }, audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      log(this.logEl, 'camera opened');
      this.startPreview();
    } catch (e) {
      // No camera (denied or headless): encode a moving test pattern so the
      // feedback->knob loop is still fully demonstrable.
      this.synthetic = true;
      log(this.logEl, `no camera (${(e as Error).message}) — using synthetic pattern`);
      this.startPreview();
    }
  }

  // Signaling can complete before any start button is pressed (a host may
  // only ever touch the P2P panel); the guest's HELLO — and PLAY — must
  // still be answerable, so create the encoder synchronously and let the
  // camera come up in the background.
  ensureSession(): void {
    const withMic = ($('micCheck') as HTMLInputElement).checked;
    if (!this.enc) this.initEncoder(withMic);
    if (!this.started) {
      void this.start(withMic).catch((e) => log(this.logEl, `start error: ${(e as Error).message}`));
    }
  }

  // Spec section 2.1 step 4: media flows after PLAY.
  handleGuestText(line: string): void {
    const verb = line.split(' ', 1)[0];
    if (verb === 'HELLO') {
      this.ensureSession();
      if (!/v=2\b/.test(line)) { this.relay.sendText('BYE'); return; }
      this.relay.sendText('CONFIG');
      this.relay.sendBinary(this.enc.headerBytes().slice());
      log(this.logEl, 'session: HELLO accepted, CONFIG + header sent');
    } else if (verb === 'PLAY') {
      this.ensureSession();
      if (!this.running) { this.running = true; this.captureLoop(); }
    } else if (verb === 'NACK') {
      this.sender.handleNack(line);
    } else if (verb === 'PING') {
      const t = /t=(\d+)/.exec(line)?.[1];
      this.relay.sendText(t ? `PONG t=${t}` : 'PONG');
    } else if (verb === 'REPORT') {
      const loss = parseFloat(/loss=(\d+)/.exec(line)?.[1] ?? '0');
      const rtt = parseInt(/rtt=(\d+)/.exec(line)?.[1] ?? '0', 10) / 1000;
      const buf = parseFloat(/buf=(\d+)/.exec(line)?.[1] ?? '0');
      // Reference mapping of the ladder's bandwidth row: the channel
      // delivers what loss does not eat (spec section 6).
      this.controller.onReport(loss, rtt, buf, 1000 / this.fps, (100 - loss) / 100);
      this.applyFec();
    } else if (verb === 'KEYFRAME') {
      const now = Date.now();
      if (now - this.lastKeyframeRequestAt >= 1000) {
        this.lastKeyframeRequestAt = now;
        this.forceKeyframe = true;
        log(this.logEl, 'control: KEYFRAME request accepted');
      } else {
        log(this.logEl, 'control: KEYFRAME rate-limited');
      }
    }
  }

  // draws the current source (camera or synthetic pattern) into the
  // capture canvas, honouring the downscale rung
  private drawCaptureFrame(): void {
    const t = performance.now() / 1000;
    const rung = this.controller.downscaleStage > 0
      ? QOV_DOWNSCALE_STAGES[this.controller.downscaleStage - 1]
      : null;
    if (this.synthetic) {
      if (rung) {
        // same rung for the synthetic pattern: draw scaled into the
        // centered rung region over black
        this.captureCtx.fillStyle = '#000';
        this.captureCtx.fillRect(0, 0, WIDTH, HEIGHT);
        const k = rung.w / WIDTH;
        this.captureCtx.setTransform(k, 0, 0, k, (WIDTH - rung.w) / 2, (HEIGHT - rung.h) / 2);
      }
      const g = this.captureCtx.createLinearGradient(0, 0, WIDTH, HEIGHT);
      g.addColorStop(0, `hsl(${(t * 40) % 360}, 70%, 55%)`);
      g.addColorStop(1, `hsl(${(t * 40 + 120) % 360}, 70%, 35%)`);
      this.captureCtx.fillStyle = g;
      this.captureCtx.fillRect(0, 0, WIDTH, HEIGHT);
      this.captureCtx.fillStyle = '#fff';
      this.captureCtx.font = 'bold 28px system-ui';
      this.captureCtx.fillText(`QOV-S ${Math.floor(t)}`, 40 + 20 * Math.sin(t * 2), HEIGHT / 2 + 60 * Math.sin(t));
      if (rung) this.captureCtx.setTransform(1, 0, 0, 1, 0, 0);
    } else if (this.video.readyState < 2) {
      // camera not producing frames yet (PLAY raced openCamera): hold black
      this.captureCtx.fillStyle = '#000';
      this.captureCtx.fillRect(0, 0, WIDTH, HEIGHT);
    } else if (rung) {
      // ladder rung: shrink the picture, letterbox the border — border
      // blocks are pure skips, content codes at unchanged quality
      this.captureCtx.fillStyle = '#000';
      this.captureCtx.fillRect(0, 0, WIDTH, HEIGHT);
      this.captureCtx.drawImage(this.video, (WIDTH - rung.w) / 2, (HEIGHT - rung.h) / 2, rung.w, rung.h);
    } else {
      this.captureCtx.drawImage(this.video, 0, 0, WIDTH, HEIGHT);
    }
  }

  // live local preview before a guest connects (PLAY starts the real loop)
  private startPreview(): void {
    if (this.previewTimer !== null) return;
    this.previewTimer = window.setInterval(() => {
      if (this.running) {
        clearInterval(this.previewTimer!);
        this.previewTimer = null;
        return;
      }
      this.drawCaptureFrame();
      ($('hostCanvas') as HTMLCanvasElement).getContext('2d')!.drawImage(this.captureCanvas, 0, 0);
    }, 100);
  }

  private nextCaptureAt = 0;

  private captureLoop = (): void => {
    if (!this.running) return;
    const outCtx = ($('hostCanvas') as HTMLCanvasElement).getContext('2d')!;
    const tick = () => {
      if (!this.running) return;
      if (this.controller.shouldSkipFrame()) {
        this.skipCount++; // ladder knob: frame skip (spec section 6)
      } else {
        this.drawCaptureFrame();
        const pixels = this.captureCtx.getImageData(0, 0, WIDTH, HEIGHT).data;
        const ts = Math.round(performance.now() * 1000);
        if (this.forceKeyframe || this.framesSinceKf >= 120) {
          this.enc.encodeKeyframe(pixels, ts);
          this.forceKeyframe = false;
          this.framesSinceKf = 0;
        } else {
          this.enc.encodePFrame(pixels, ts);
          this.framesSinceKf++;
        }
        this.frameCount++;
        outCtx.drawImage(this.captureCanvas, 0, 0);
      }
      // drift-free pacing: aim at the next grid point — "now + interval"
      // would accumulate the capture/encode cost into every frame gap
      const now = performance.now();
      if (this.nextCaptureAt === 0 || this.nextCaptureAt < now - 250) this.nextCaptureAt = now;
      this.nextCaptureAt += 1000 / this.fps;
      setTimeout(this.captureLoop, Math.max(1, this.nextCaptureAt - now));
    };
    tick();
  };

  private tickSecond(): void {
    this.bitrateKbps = Math.round((this.bytesThisSecond * 8) / 1000);
    this.bytesThisSecond = 0;
  }

  render(): void {
    $('hostStats').innerHTML = fmtStats([
      ['frames encoded', this.frameCount],
      ['bitrate', `${this.bitrateKbps} kbps`],
      ['quality knob', this.controller.currentQuality],
      ['FEC ratio', this.sender.getFecGroupSize() ? `1:${this.sender.getFecGroupSize()}` : 'off'],
      ['frame skips', this.skipCount],
      ['downscale events', this.downscaleCount],
      ['dropReference', this.dropRefCount],
      ['retransmits', this.sender.retransmits],
      ['packets sent', this.sender.sentPackets],
      ['audio frames sent', this.audioFrames],
      ['audio suppressed (DTX)', this.audioSuppressed],
    ]);
  }
}

// ----------------------------------------------------------------- guest

class Guest {
  private relay: Carrier;
  // transports are hot-swappable (relay <-> peer-to-peer)
  rebind(carrier: Carrier): void { this.relay = carrier; }
  private receiver: QovStreamReceiver;
  private gate = new QovPlaybackGate();
  private readonly qoa = new QoaDecoder();
  private readonly actx = new AudioContext({ sampleRate: QOV_AUDIO_RATE_SPEECH });
  private nextAudioAt = 0;
  private audioPlayed = 0;
  private decoder: QovStreamingDecoder | null = null;
  private buffer = new Uint8Array(8 << 20);
  private writePos = 0;
  private decodeQueue: Uint8Array[] = [];
  private pumping = false;
  private nextFrame = 0;
  // decoded-but-not-yet-shown frames; the display clock drains this at the
  // stream's own pace so arrival bursts play smoothly (bounded for latency)
  private pendingFrames: { index: number; pixels: Uint8ClampedArray; decision: PlaybackDecision }[] = [];
  private nextDue = 0; // display clock anchor (ms, performance.now() scale)
  private displayTimer: number | null = null;
  private headerIntervalMs = 100; // corrected from the QOV header on CONFIG
  private framesShown = 0;
  private hasPicture = false;
  private healingCount = 0;
  private freezeStart = 0;
  private totalFreezeMs = 0;
  private ctx: CanvasRenderingContext2D;

  constructor(relay: Carrier, private logEl: HTMLElement, private badgeEl: HTMLElement) {
    this.relay = relay;
    const canvas = $('guestCanvas') as HTMLCanvasElement;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.ctx = canvas.getContext('2d')!;

    this.receiver = new QovStreamReceiver(
      (chunk, isAudio) => {
        if (isAudio) { this.playAudio(chunk); return; }
        this.decodeQueue.push(chunk);
        void this.pump();
      },
      (line) => this.relay.sendText(line),
      { frameIntervalMs: 100 }, // corrected from the QOV header fps on CONFIG
    );
    this.receiver.onFrameDropped = () => {
      this.gate.onFrameLost();
      if (this.freezeStart === 0) this.freezeStart = Date.now();
      log(this.logEl, 'frame lost — freeze last good frame');
    };
    this.receiver.start();
  }

  // Spec section 2.1 step 1: the client opens with HELLO.
  hello(): void {
    this.relay.sendText('HELLO token=dev v=2');
    log(this.logEl, 'session: HELLO sent');
  }

  handleHostText(line: string): void {
    if (line.startsWith('PONG')) this.receiver.handlePong(line);
  }

  handleBinary(bytes: Uint8Array): void {
    if (!this.decoder) {
      if (this.looksLikeQovHeader(bytes)) this.acceptHeader(bytes);
      return; // drop everything until the session is established
    }
    // Simulated datagram loss (slider): drop media packets before the
    // protocol layer so NACK/FEC/freeze machinery is exercised end-to-end.
    const lossPct = parseInt(($('lossSlider') as HTMLInputElement).value, 10);
    if (lossPct > 0 && Math.random() * 100 < lossPct) return;
    this.receiver.handlePacket(bytes);
  }

  private looksLikeQovHeader(bytes: Uint8Array): boolean {
    return bytes.length >= 24 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'qovf';
  }

  // Spec section 2.1 step 2: CONFIG is followed by the QOV file header.
  // A relay restart (partner rejoin) re-sends it; keep the decoder (the
  // peer's encode state is continuous), but reset the receiver: a peer
  // whose page reloaded starts frame/seq ids over, and the old watermarks
  // would reject every new packet as late.
  private acceptHeader(header: Uint8Array): void {
    if (this.decoder) { this.receiver.reset(); this.relay.sendText('PLAY'); return; }

    this.ensureCapacity(header.length);
    this.buffer.set(header, 0);
    this.writePos = header.length;

    const num = (header[10] << 8) | header[11];
    const den = (header[12] << 8) | header[13];
    if (num > 0) {
      this.headerIntervalMs = (1000 * den) / num;
      this.receiver.setFrameIntervalMs((1000 * den) / num);
    }

    const source: StreamDataSource = {
      read: async (offset, length) => this.buffer.subarray(offset, offset + length),
      isAvailable: (offset, length) => offset + length <= this.writePos,
      getSize: () => null, // live stream: open-ended
      getLoadedSize: () => this.writePos,
    };
    this.decoder = new QovStreamingDecoder(source);
    void this.decoder.parseHeader();
    this.startDisplayLoop();
    log(this.logEl, `session: header accepted (${header.length} bytes, ${num}/${den} fps)`);
    this.relay.sendText('PLAY');
  }

  private ensureCapacity(need: number): void {
    if (this.writePos + need <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < this.writePos + need) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.buffer.subarray(0, this.writePos));
    this.buffer = bigger;
  }

  // Audio playout: schedule each decoded frame on the 16 kHz device clock,
  // chaining from the previous frame so network jitter becomes buffer, not
  // gap (timestamps only aligned the streams at session start — spec 5.3).
  private playAudio(chunk: Uint8Array): void {
    // chunk is a complete AUDIO chunk: [type(1) flags(1) size(4) ts(4)][payload]
    // (audio is never compressed, spec section 5.3)
    if (chunk[1] === QOV_CHUNK_AUDIO_FLAG_OPUS) { this.playOpus(chunk.subarray(10)); return; }
    const frame = this.qoa.decodeFrame(chunk.subarray(10));
    if (!frame) return;
    this.scheduleMono(frame.samples);
    this.audioPlayed++;
  }

  private scheduleMono(mono: Float32Array): void {
    void this.actx.resume();
    const buffer = this.actx.createBuffer(1, mono.length, this.actx.sampleRate);
    buffer.getChannelData(0).set(mono);
    const node = this.actx.createBufferSource();
    node.buffer = buffer;
    this.nextAudioAt = Math.max(this.actx.currentTime + 0.03, this.nextAudioAt);
    node.start(this.nextAudioAt);
    this.nextAudioAt += mono.length / this.actx.sampleRate;
  }

  private audioDecoder: AudioDecoder | null = null;
  private audioSkipped = 0;

  // Opus playout (spec 5.3 flag 0x01): the platform WebCodecs decoder.
  // Reference decoders skip alternate codecs; the demo product plays them.
  private playOpus(packet: Uint8Array): void {
    if (typeof AudioDecoder === 'undefined') { this.audioSkipped++; return; }
    if (!this.audioDecoder) {
      const dec = new AudioDecoder({
        output: (ad) => {
          const mono = new Float32Array(ad.numberOfFrames);
          ad.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
          ad.close();
          this.scheduleMono(mono);
          this.audioPlayed++;
        },
        error: (e) => log(this.logEl, `opus decoder error: ${e.message} — audio stopped`),
      });
      dec.configure({ codec: 'opus', sampleRate: QOV_AUDIO_RATE_SPEECH, numberOfChannels: 1 });
      this.audioDecoder = dec;
    }
    if (this.audioDecoder.decodeQueueSize > 20) { this.audioSkipped++; return; }
    this.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: 0, data: packet }));
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.decoder) return;
    this.pumping = true;
    try {
      while (this.decodeQueue.length > 0) {
        const chunk = this.decodeQueue.shift()!;
        this.ensureCapacity(chunk.length);
        this.buffer.set(chunk, this.writePos);
        this.writePos += chunk.length;

        const info = inspectChunk(chunk);
        // the gate decision belongs to the frame's ARRIVAL: keyframe /
        // refresh-band transitions must register even if the display clock
        // later skips the frame while catching up
        const decision = this.gate.onFrameArrived(info.isKeyframe, info.hasRefreshBand);

        await this.decoder.extendIndex();
        while (this.nextFrame < this.decoder.frameCount) {
          const index = this.nextFrame++;
          const frame = await this.decoder.decodeFrame(index);
          if (!frame) break;
          // decode now, display on schedule — network jitter lands in the
          // small buffer below instead of hitting the canvas 1:1 as stutter
          this.pendingFrames.push({ index, pixels: frame.pixels, decision });
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private startDisplayLoop(): void {
    if (this.displayTimer !== null) return;
    this.displayTimer = window.setInterval(() => this.displayTick(), 10);
  }

  // Frames are captured on the host's clock and shown on this schedule
  // (same pattern as the file player) instead of being drawn the instant a
  // packet lands. Live latency stays bounded: a backlog deeper than 4
  // frames means we fell behind, so jump to the newest picture.
  private displayTick(): void {
    if (this.pendingFrames.length === 0) return;
    const now = performance.now();
    if (this.nextDue === 0) this.nextDue = now; // first picture plays at once
    if (now < this.nextDue) return;
    if (this.pendingFrames.length > 4) {
      const newest = this.pendingFrames[this.pendingFrames.length - 1];
      this.pendingFrames.length = 0;
      this.pendingFrames.push(newest);
    }
    const f = this.pendingFrames.shift()!;
    if (f.decision === PlaybackDecision.Display) {
      const img = this.ctx.createImageData(WIDTH, HEIGHT);
      img.data.set(f.pixels);
      this.ctx.putImageData(img, 0, 0);
      this.hasPicture = true;
      this.framesShown++;
      if (this.freezeStart > 0) {
        this.totalFreezeMs += Date.now() - this.freezeStart;
        this.freezeStart = 0;
        log(this.logEl, 'playback resumed');
      }
    } else {
      this.healingCount++; // decoded, but the display stays frozen while healing
    }
    const interval = this.intervalAfter(f.index);
    if (now - this.nextDue > 250) this.nextDue = now + interval; // far behind: resync
    else this.nextDue = this.nextDue + interval;
  }

  // ms between frame i and i+1 from the capture timestamps (µs, host
  // clock); the header interval is the fallback while the next frame is
  // not indexed yet or the timestamps repeat (host skipped nothing)
  private intervalAfter(i: number): number {
    if (!this.decoder) return this.headerIntervalMs;
    const deltaMs = (this.decoder.frameTimestamp(i + 1) - this.decoder.frameTimestamp(i)) / 1000;
    if (!(deltaMs > 0.5) || deltaMs > 1000) return this.headerIntervalMs;
    return deltaMs;
  }

  render(): void {
    const frozen = this.gate.isHealing;
    badge(this.badgeEl, frozen ? 'frozen' : this.hasPicture ? 'live' : 'waiting',
      frozen ? 'frozen (healing)' : this.hasPicture ? 'live' : 'waiting');
    $('guestStats').innerHTML = fmtStats([
      ['frames shown', this.framesShown],
      ['frames dropped', this.receiver.framesDropped],
      ['FEC recoveries', this.receiver.fecRecoveries],
      ['NACKs sent', this.receiver.nackSent],
      ['RTT', this.receiver.lastRttMs >= 0 ? `${this.receiver.lastRttMs.toFixed(1)} ms` : '—'],
      ['report loss', `${this.receiver.lastReportLoss.toFixed(1)}%`],
      ['healed frames', this.healingCount],
      ['frozen total', `${(this.totalFreezeMs / 1000).toFixed(1)} s`],
      ['audio played', this.audioPlayed],
      ['audio skipped (no codec)', this.audioSkipped],
    ]);
  }
}

// ------------------------------------------------------------------ init

function main(): void {
  const p2p = new WebRtcCarrier();
  const relay = new Relay();
  let carrier: Carrier = p2p;

  const host = new Host(carrier, $('hostLog'));
  const guest = new Guest(carrier, $('guestLog'), $('guestBadge'));
  setInterval(() => { host.render(); guest.render(); }, 500);

  let current: 'host' | 'guest' | null = null;

  // Strict role split: only the guest says HELLO, and each side consumes
  // only the lines the peer owns. Both handlers used to run on both tabs,
  // so a guest tab executed Host.handleGuestText with no encoder (and even
  // replied CONFIG into the channel) as soon as the peer's HELLO arrived.
  const wireActive = (c: Carrier) => {
    c.onOpen = () => { if (current === 'guest') guest.hello(); };
    c.onText = (line) => {
      if (current === 'host') host.handleGuestText(line);
      else if (current === 'guest') guest.handleHostText(line);
    };
    c.onBinary = (bytes) => { if (current === 'guest') guest.handleBinary(bytes); };
  };
  wireActive(carrier);
  const useCarrier = (kind: 'p2p' | 'relay') => {
    carrier = kind === 'relay' ? relay : p2p;
    wireActive(carrier);
    host.rebind(carrier);
    guest.rebind(carrier);
  };

  const join = (role: 'host' | 'guest') => {
    if (current === role) return;
    current = role;
    $('btnHost').classList.toggle('active', role === 'host');
    $('btnGuest').classList.toggle('active', role === 'guest');
    $('hostPanel').style.display = role === 'host' ? '' : 'none';
    $('guestPanel').style.display = role === 'guest' ? '' : 'none';
    const kind = ($('carrierSelect') as HTMLSelectElement).value as 'p2p' | 'relay';
    // join() is the single entry point for carrier wiring: handlers and
    // rebinds must follow the selected carrier even when the dropdown never
    // fired change (e.g. ?carrier=relay preset) — otherwise lines are sent
    // into the idle carrier and the session silently dead-ends.
    useCarrier(kind);
    if (kind === 'relay') {
      $('relayUrl').style.display = '';
      $('p2pPanel').style.display = 'none';
      const actualRoom = new URLSearchParams(location.search).get('room') ?? 'qovs-call-default';
      relay.connect(($('relayUrl') as HTMLInputElement).value, actualRoom, $('relayState'));
    } else {
      $('relayUrl').style.display = 'none';
      // the .p2p class defaults to display:none — an inline '' would not
      // override it, so show means explicitly 'block'
      $('p2pPanel').style.display = 'block';
      $('p2pHostSteps').style.display = role === 'host' ? '' : 'none';
      $('p2pGuestSteps').style.display = role === 'guest' ? '' : 'none';
    }
  };
  const start = (opts?: { autoInvite?: boolean }) => {
    if (current !== 'host') return;
    const withMic = ($('micCheck') as HTMLInputElement).checked;
    host.start(withMic).catch((e) => log($('hostLog'), `start error: ${e.message}`));
    // P2P hosts get their invite link immediately — no second click
    if (opts?.autoInvite !== false &&
        ($('carrierSelect') as HTMLSelectElement).value === 'p2p') createInvite();
  };

  const createInvite = () => {
    useCarrier('p2p');
    p2p.createInvite($('relayState'))
      .then((code) => {
        const link = shareLink('invite', code);
        const out = $('p2pInviteOut') as HTMLTextAreaElement;
        out.value = link;
        out.style.borderColor = '#ef4444'; out.style.borderWidth = '2px';
        copyBtn('p2pInviteCopy', link);
        badge($('relayState'), 'waiting', 'p2p: invite ready — copy the link below');
        out.scrollIntoView({ behavior: 'smooth', block: 'center' });
        out.focus();
        out.select();
        log($('hostLog'), 'p2p: invite link ready — send it to your guest');
      })
      .catch((e) => log($('hostLog'), `p2p invite error: ${e.message}`));
  };
  $('btnHost').onclick = () => { join('host'); start(); };
  $('btnGuest').onclick = () => join('guest');
  $('carrierSelect').onchange = () => {
    useCarrier(($('carrierSelect') as HTMLSelectElement).value as 'p2p' | 'relay');
    join(current ?? 'host');
    start();
  };

  // --- P2P signaling (share links, spec v2.2 section 7) ---
  function copyBtn(id: string, text: string) {
    const b = $(id) as HTMLButtonElement;
    b.style.display = '';
    b.onclick = () => {
      navigator.clipboard.writeText(text).then(() => { b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy link'), 1500); });
    };
  }
  const connectAnswer = (input: string) => {
    const { code } = parseSignalInput(input);
    if (current !== 'host') join('host'); // answering an invite is hosting intent
    start({ autoInvite: false });         // no-op once the session already runs
    p2p.acceptAnswer(code)
      .then(() => log($('hostLog'), 'p2p: answer applied — connecting'))
      .catch((e) => log($('hostLog'), `p2p answer error: ${e.message}`));
  };
  $('p2pHostCreate').onclick = () => createInvite();
  $('p2pAcceptAnswer').onclick = () => {
    connectAnswer(($('p2pAnswerIn') as HTMLTextAreaElement).value);
  };
  $('p2pGuestCreate').onclick = () => {
    useCarrier('p2p');
    const { code } = parseSignalInput(($('p2pInviteIn') as HTMLTextAreaElement).value);
    p2p.acceptInvite(code, $('relayState'))
      .then((answer) => {
        const link = shareLink('answer', answer);
        const aout = $('p2pAnswerOut') as HTMLTextAreaElement;
        aout.value = link;
        aout.style.borderColor = '#ef4444'; aout.style.borderWidth = '2px';
        copyBtn('p2pAnswerCopy', link);
        log($('guestLog'), 'p2p: send the answer link back to the host');
      })
      .catch((e) => log($('guestLog'), `p2p answer error: ${e.message}`));
  };

  // Opening an invite link auto-joins as guest and answers it; an answer
  // link opened by the host itself auto-connects (same-tab only).
  const applyHash = () => {
    const h = location.hash;
    const mi = /#invite=([A-Za-z0-9_-]+)/.exec(h);
    const ma = /#answer=([A-Za-z0-9_-]+)/.exec(h);
    if (mi) {
      history.replaceState(null, '', location.pathname + location.search);
      join('guest');
      useCarrier('p2p');
      p2p.acceptInvite(fromUrlSafe(mi[1]), $('relayState'))
        .then((answer) => {
          const link = shareLink('answer', answer);
          const aout = $('p2pAnswerOut') as HTMLTextAreaElement;
          aout.value = link;
          aout.style.borderColor = '#ef4444'; aout.style.borderWidth = '2px';
          copyBtn('p2pAnswerCopy', link);
          log($('guestLog'), 'p2p: invite applied — send the answer link back to the host');
        })
        .catch((e) => log($('guestLog'), `p2p answer error: ${e.message}`));
    } else if (ma) {
      history.replaceState(null, '', location.pathname + location.search);
      join('host');
      useCarrier('p2p');
      start({ autoInvite: false }); // the answer belongs to an earlier offer
      connectAnswer(fromUrlSafe(ma[1]));
    }
  };
  if (location.hash.includes('invite=') || location.hash.includes('answer=')) applyHash();
  window.addEventListener('hashchange', applyHash);

  // ?carrier=relay preselects the local relay carrier (p2p is the default)
  if (new URLSearchParams(location.search).get('carrier') === 'relay') {
    ($('carrierSelect') as HTMLSelectElement).value = 'relay';
  }
  ($('relayUrl') as HTMLInputElement).value =
    `ws://${location.hostname || 'localhost'}:8882`;

  // visible build marker: makes a stale tab obvious
  {
    const bm = $('buildMarker') as HTMLElement;
    bm.textContent = `\u00b7 demo build 2026-09-17.2 (paced guest playback)`;
  }

  // debugging handle for the demo page
  (window as unknown as { __qov: unknown }).__qov = {
    p2p, relay, host, guest, useCarrier,
    get carrier() { return carrier; },
  };
}

main();
