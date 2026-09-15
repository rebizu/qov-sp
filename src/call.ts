// QOV-S v2.0 demo: 1:1 call over the WebSocket binding (qov-streaming-spec.md
// sections 1.2/7) with the full feedback->knob loop visible in the UI.
//
// Host: camera -> QOV encode (quality driven by the adaptation ladder) ->
// QOV-S sender -> relay. Guest: relay -> simulated datagram loss ->
// QOV-S receiver -> streaming decoder, gated by the playback gate
// (freeze last good frame, heal over refresh bands) -> REPORTs back.
import { QovEncoder } from './qov-encoder';
import { QoaDecoder } from './qoa';
import { QOV_AUDIO_RATE_SPEECH } from './qov-types';
import { QovStreamSender, QovStreamReceiver } from './qov-streaming';
import { QovPlaybackGate, QovAdaptationController, PlaybackDecision, inspectChunk } from './qov-adaptation';
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

class Relay {
  ws: WebSocket | null = null;
  onText: (line: string) => void = () => {};
  onBinary: (bytes: Uint8Array) => void = () => {};
  onOpen: () => void = () => {};

  connect(url: string, room: string, stateEl: HTMLElement): void {
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

// ------------------------------------------------------------------ host

class Host {
  private relay: Relay;
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

  constructor(relay: Relay, private logEl: HTMLElement) {
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
      withMic ? 1 : 0, withMic ? QOV_AUDIO_RATE_SPEECH : 0);
    this.enc.writeHeader();
    this.enc.onChunk = (chunk) => {
      this.bytesThisSecond += chunk.length;
      this.sender.sendChunk(chunk, chunk[0] === 0x10);
    };
  }

  private audioFrames = 0;

  // Speech capture (spec section 5.3): 16 kHz mono QOA frames cut from the
  // browser's audio processing chain (echo cancellation / noise suppression
  // / AGC via getUserMedia constraints — product scope, not format).
  private async startMic(): Promise<void> {
    const astream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const actx = new AudioContext({ sampleRate: QOV_AUDIO_RATE_SPEECH });
    await actx.resume();
    const src = actx.createMediaStreamSource(astream);
    const proc = actx.createScriptProcessor(1024, 1, 1);
    const sink = actx.createGain();
    sink.gain.value = 0; // ScriptProcessor only fires when routed to a destination
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
    src.connect(proc);
    proc.connect(sink);
    sink.connect(actx.destination);
    log(this.logEl, `microphone open (${actx.sampleRate} Hz mono, browser AEC/NS/AGC)`);
  }

  get fps(): number { return parseInt(($('fpsSlider') as HTMLInputElement).value, 10); }

  // The combobox is the operator's ceiling: "off" forces FEC off entirely,
  // otherwise the ladder modulates between 1:4 / 1:3 / off per report.
  applyFec(): void {
    const mode = ($('fecSelect') as HTMLSelectElement).value;
    this.sender.setFecGroupSize(mode === '0' ? 0 : this.controller.fecGroupSize || (mode === '3' ? 3 : 4));
  }

  private synthetic = false;

  async start(withMic: boolean): Promise<void> {
    this.initEncoder(withMic);
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
    } catch (e) {
      // No camera (denied or headless): encode a moving test pattern so the
      // feedback->knob loop is still fully demonstrable.
      this.synthetic = true;
      log(this.logEl, `no camera (${(e as Error).message}) — using synthetic pattern`);
    }
  }

  // Spec section 2.1 step 4: media flows after PLAY.
  handleGuestText(line: string): void {
    const verb = line.split(' ', 1)[0];
    if (verb === 'HELLO') {
      if (!/v=2\b/.test(line)) { this.relay.sendText('BYE'); return; }
      this.relay.sendText('CONFIG');
      this.relay.sendBinary(this.enc.headerBytes().slice());
      log(this.logEl, 'session: HELLO accepted, CONFIG + header sent');
    } else if (verb === 'PLAY') {
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

  private captureLoop = (): void => {
    if (!this.running) return;
    const outCtx = ($('hostCanvas') as HTMLCanvasElement).getContext('2d')!;
    const tick = () => {
      if (!this.running) return;
      if (this.controller.shouldSkipFrame()) {
        this.skipCount++; // ladder knob: frame skip (spec section 6)
      } else {
        if (this.synthetic) {
          const t = performance.now() / 1000;
          const g = this.captureCtx.createLinearGradient(0, 0, WIDTH, HEIGHT);
          g.addColorStop(0, `hsl(${(t * 40) % 360}, 70%, 55%)`);
          g.addColorStop(1, `hsl(${(t * 40 + 120) % 360}, 70%, 35%)`);
          this.captureCtx.fillStyle = g;
          this.captureCtx.fillRect(0, 0, WIDTH, HEIGHT);
          this.captureCtx.fillStyle = '#fff';
          this.captureCtx.font = 'bold 28px system-ui';
          this.captureCtx.fillText(`QOV-S ${Math.floor(t)}`, 40 + 20 * Math.sin(t * 2), HEIGHT / 2 + 60 * Math.sin(t));
        } else {
          this.captureCtx.drawImage(this.video, 0, 0, WIDTH, HEIGHT);
        }
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
      setTimeout(this.captureLoop, Math.max(1, 1000 / this.fps));
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
      ['dropReference', this.dropRefCount],
      ['retransmits', this.sender.retransmits],
      ['packets sent', this.sender.sentPackets],
      ['audio frames sent', this.audioFrames],
    ]);
  }
}

// ----------------------------------------------------------------- guest

class Guest {
  private relay: Relay;
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
  private framesShown = 0;
  private hasPicture = false;
  private healingCount = 0;
  private freezeStart = 0;
  private totalFreezeMs = 0;
  private ctx: CanvasRenderingContext2D;

  constructor(relay: Relay, private logEl: HTMLElement, private badgeEl: HTMLElement) {
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
  // A relay restart (partner rejoin) re-sends it; keep the live decoder.
  private acceptHeader(header: Uint8Array): void {
    if (this.decoder) { this.relay.sendText('PLAY'); return; }

    this.ensureCapacity(header.length);
    this.buffer.set(header, 0);
    this.writePos = header.length;

    const num = (header[10] << 8) | header[11];
    const den = (header[12] << 8) | header[13];
    if (num > 0) this.receiver.setFrameIntervalMs((1000 * den) / num);

    const source: StreamDataSource = {
      read: async (offset, length) => this.buffer.subarray(offset, offset + length),
      isAvailable: (offset, length) => offset + length <= this.writePos,
      getSize: () => null, // live stream: open-ended
      getLoadedSize: () => this.writePos,
    };
    this.decoder = new QovStreamingDecoder(source);
    void this.decoder.parseHeader();
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

  // QOA playout: schedule each decoded frame on the 16 kHz device clock,
  // chaining from the previous frame so network jitter becomes buffer, not
  // gap (timestamps only aligned the streams at session start — spec 5.3).
  private playAudio(chunk: Uint8Array): void {
    // chunk is a complete AUDIO chunk: strip the 10-byte QOV chunk header
    // (audio is never compressed, spec section 5.3) to get the QOA frame
    const frame = this.qoa.decodeFrame(chunk.subarray(10));
    if (!frame) return;
    void this.actx.resume();
    const mono = frame.samples.length === frame.header.channels
      ? frame.samples : frame.samples;
    const buffer = this.actx.createBuffer(1, mono.length, this.actx.sampleRate);
    buffer.getChannelData(0).set(mono);
    const node = this.actx.createBufferSource();
    node.buffer = buffer;
    this.nextAudioAt = Math.max(this.actx.currentTime + 0.03, this.nextAudioAt);
    node.start(this.nextAudioAt);
    this.nextAudioAt += mono.length / this.actx.sampleRate;
    this.audioPlayed++;
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
        const decision = this.gate.onFrameArrived(info.isKeyframe, info.hasRefreshBand);

        await this.decoder.extendIndex();
        while (this.nextFrame < this.decoder.frameCount) {
          const frame = await this.decoder.decodeFrame(this.nextFrame++);
          if (!frame) break;
          if (decision === PlaybackDecision.Display) {
            const img = this.ctx.createImageData(WIDTH, HEIGHT);
            img.data.set(frame.pixels);
            this.ctx.putImageData(img, 0, 0);
            this.hasPicture = true;
            this.framesShown++;
            if (this.freezeStart > 0) {
              this.totalFreezeMs += Date.now() - this.freezeStart;
              this.freezeStart = 0;
              log(this.logEl, 'playback resumed');
            }
          } else {
            this.healingCount++; // decoded into scratch state, display frozen
          }
        }
      }
    } finally {
      this.pumping = false;
    }
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
    ]);
  }
}

// ------------------------------------------------------------------ init

function main(): void {
  ($('relayUrl') as HTMLInputElement).value =
    `ws://${location.hostname || 'localhost'}:8882`;
  const relay = new Relay();

  const host = new Host(relay, $('hostLog'));
  const guest = new Guest(relay, $('guestLog'), $('guestBadge'));
  setInterval(() => { host.render(); guest.render(); }, 500);

  let joined = false;
  const join = (role: 'host' | 'guest') => {
    if (joined) return;
    joined = true;
    $('btnHost').classList.toggle('active', role === 'host');
    $('btnGuest').classList.toggle('active', role === 'guest');
    $('hostPanel').style.display = role === 'host' ? '' : 'none';
    $('guestPanel').style.display = role === 'guest' ? '' : 'none';
    const actualRoom = new URLSearchParams(location.search).get('room') ?? 'qovs-call-default';
    relay.connect(($('relayUrl') as HTMLInputElement).value, actualRoom, $('relayState'));
  };
  $('btnHost').onclick = () => {
    join('host');
    const withMic = ($('micCheck') as HTMLInputElement).checked;
    host.start(withMic).catch((e) => log($('hostLog'), `start error: ${e.message}`));
  };
  $('btnGuest').onclick = () => join('guest');

  relay.onOpen = () => guest.hello();
  relay.onText = (line) => {
    // Both roles see every control line; each side consumes what it owns.
    host.handleGuestText(line);
    guest.handleHostText(line);
  };
  relay.onBinary = (bytes) => guest.handleBinary(bytes);
}

main();
