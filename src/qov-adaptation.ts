// QOV-S v2.0 app layer (qov-streaming-spec.md section 6): the receiver-side
// playback gate (freeze last good frame + refresh-band healing) and the
// sender-side adaptation ladder binding receiver reports to setQuality /
// dropReference (spec v3.6 section 4.1). TypeScript mirror of
// csharp_qov/QovLibrary/QovAdaptation.cs.
import { QOV_CHUNK_FLAG_REFRESH_BAND, QOV_CHUNK_KEYFRAME, chunkHasSizePrefix } from './qov-types';

// QOV_INTRA_REFRESH_BANDS (spec v3.6 section 3.4.4): the rolling band
// repaints the whole frame every 12 P-frames.
export const QOV_REFRESH_BAND_CYCLE = 12;

// Downscale rungs of the adaptation ladder, engaged in order under sustained
// deficit: stage 1 letterboxes the camera into 256x192, stage 2 into 160x120.
// Content quality is unchanged at both rungs — the picture gets smaller, not
// worse — and border blocks are pure skips (BENCHMARKS section 1d).
export const QOV_DOWNSCALE_STAGES: ReadonlyArray<{ w: number; h: number }> = [
  { w: 256, h: 192 },
  { w: 160, h: 120 },
];

// (isKeyframe, hasRefreshBand, bandIndex) from a complete QOV chunk.
export function inspectChunk(chunk: Uint8Array, use32BitChunkSize = true): {
  isKeyframe: boolean; hasRefreshBand: boolean; bandIndex: number;
} {
  const type = chunk[0];
  const flags = chunk[1];
  const headerSize = use32BitChunkSize ? 10 : 8;
  const bandOffset = headerSize + (chunkHasSizePrefix(flags) ? 4 : 0);
  const hasBand = (flags & QOV_CHUNK_FLAG_REFRESH_BAND) !== 0 && chunk.length > bandOffset;
  return {
    isKeyframe: type === QOV_CHUNK_KEYFRAME,
    hasRefreshBand: hasBand,
    bandIndex: hasBand ? chunk[bandOffset] : -1,
  };
}

export enum PlaybackDecision {
  // Decode and show.
  Display,
  // Decode into scratch state while the display stays frozen on the last
  // good frame (spec section 6 "freeze, don't glitch").
  Heal,
}

export class QovPlaybackGate {
  private readonly keyframeRequestIntervalMs: number;
  private healing = false;
  private bandsPainted = 0;
  private bandsInStream = false;
  private lastKeyframeRequestAt = -1e9;

  // Fired at most once per interval (spec section 2.2 caps server handling
  // at 1/s; the receiver self-limits the same way).
  onKeyframeRequest: () => void = () => {};

  constructor(keyframeRequestIntervalMs = 1000) {
    this.keyframeRequestIntervalMs = keyframeRequestIntervalMs;
  }

  get isHealing(): boolean { return this.healing; }

  onFrameArrived(isKeyframe: boolean, hasRefreshBand: boolean): PlaybackDecision {
    if (hasRefreshBand) this.bandsInStream = true;

    if (!this.healing) return PlaybackDecision.Display;

    if (isKeyframe) {
      this.healing = false;
      this.bandsPainted = 0;
      return PlaybackDecision.Display;
    }
    if (hasRefreshBand) {
      this.bandsPainted++;
      if (this.bandsPainted >= QOV_REFRESH_BAND_CYCLE) {
        this.healing = false;
        this.bandsPainted = 0;
        return PlaybackDecision.Display;
      }
      return PlaybackDecision.Heal;
    }
    this.requestKeyframeIfNeeded();
    return PlaybackDecision.Heal;
  }

  onFrameLost(): void {
    this.healing = true;
    this.bandsPainted = 0;
    if (!this.bandsInStream) this.requestKeyframeIfNeeded();
  }

  private requestKeyframeIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastKeyframeRequestAt < this.keyframeRequestIntervalMs) return;
    this.lastKeyframeRequestAt = now;
    this.onKeyframeRequest();
  }
}

// Adaptation ladder (spec section 6). Adaptation is by subtraction: only
// remove work (frames, coefficients, references), never add machinery.
export class QovAdaptationController {
  private readonly startQuality: number;
  private readonly cooldownMs: number;
  private quality: number;
  private _fecGroupSize = 4;
  private highLossStreak = 0;
  private surplusStreak = 0;
  private skipActive = false;
  private skipToggle = false;
  private rttEma = -1;
  private lastQualityChangeAt = -1e9;
  private rung = 0;
  private rungAt = 0;
  private deficitStreak = 0;

  onQualityChanged: (q: number) => void = () => {};
  onReferenceDropped: () => void = () => {};
  onDownscaleStageChanged: (stage: number) => void = () => {};

  constructor(startQuality = 60, qualityChangeCooldownMs = 1000) {
    this.startQuality = Math.min(Math.max(startQuality, 20), 99);
    this.quality = this.startQuality;
    this.cooldownMs = qualityChangeCooldownMs;
  }

  get currentQuality(): number { return Math.round(this.quality); }
  get fecGroupSize(): number { return this._fecGroupSize; }
  get frameSkipActive(): boolean { return this.skipActive; }
  get downscaleStage(): number { return this.rung; }
  get downscaleActive(): boolean { return this.rung > 0; }
  get rttEmaMs(): number { return this.rttEma; }

  // Frame-skip knob while the playout buffer drains: skip every other frame.
  shouldSkipFrame(): boolean {
    if (!this.skipActive) return false;
    this.skipToggle = !this.skipToggle;
    return this.skipToggle;
  }

  // One receiver report (spec section 2.2 REPORT, every 500 ms).
  // deliveredRatio = media bytes delivered / media bytes sent over the
  // report interval (1.0 = the channel carries everything we emit).
  onReport(lossPercent: number, rttMs: number, bufferMs: number, frameIntervalMs: number, deliveredRatio: number): void {
    // FEC ratio (spec section 5.2): none below 0.5% loss, 1:3 above 2%.
    this._fecGroupSize = lossPercent < 0.5 ? 0 : lossPercent > 2.0 ? 3 : 4;

    // Buffer draining (< 2 frame intervals) under real channel pressure ->
    // skip every other frame (a healthy loopback keeps a near-empty buffer
    // without needing to shed frames).
    if (frameIntervalMs > 0) {
      if (bufferMs < 2 * frameIntervalMs && deliveredRatio < 0.98) this.skipActive = true;
      else if (bufferMs > 4 * frameIntervalMs || deliveredRatio >= 0.98) this.skipActive = false;
    }

    // Sustained loss > 8% -> drop the reference; the next P-frame re-keys.
    if (lossPercent > 8) {
      if (++this.highLossStreak >= 3) {
        this.highLossStreak = 0;
        this.onReferenceDropped();
      }
    } else {
      this.highLossStreak = 0;
    }

    this.rttEma = this.rttEma < 0 ? rttMs : 0.8 * this.rttEma + 0.2 * rttMs;

    // Bandwidth mapping: deficit -> q - 10 (floor 20); sustained surplus
    // (3 s = 3 consecutive clean reports) -> q + 10 (ceiling = start).
    // Ladder order: quality -> downscale rungs (quality at floor + deficit
    // persists: 256x192 first, 160x120 two deficit reports later) ->
    // reference drop -> frame skip. Recovery reverses: rungs lift before
    // quality climbs, bottom rung first.
    if (deliveredRatio < 0.9) {
      this.surplusStreak = 0;
      this.deficitStreak++;
      this.changeQuality(-10);
      if (this.currentQuality <= 20 && this.deficitStreak >= 2) {
        if (this.rung === 0) {
          this.rung = 1;
          this.rungAt = this.deficitStreak;
          this.onDownscaleStageChanged(1);
        } else if (this.rung === 1 && this.deficitStreak >= this.rungAt + 2) {
          this.rung = 2;
          this.onDownscaleStageChanged(2);
        }
      }
    } else if (lossPercent < 0.5 && deliveredRatio > 0.98) {
      this.deficitStreak = 0;
      if (++this.surplusStreak >= 3) {
        this.surplusStreak = 0;
        if (this.rung > 0) {
          this.rung--;
          this.onDownscaleStageChanged(this.rung);
        } else {
          this.changeQuality(+10);
        }
      }
    } else {
      this.surplusStreak = 0;
      this.deficitStreak = 0;
    }
  }

  private changeQuality(delta: number): void {
    const now = Date.now();
    if (now - this.lastQualityChangeAt < this.cooldownMs) return;
    const next = Math.min(Math.max(this.quality + delta, 20), this.startQuality);
    if (next === this.quality) return;
    this.lastQualityChangeAt = now;
    this.quality = next;
    this.onQualityChanged(this.currentQuality);
  }
}
