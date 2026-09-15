// QOV-S v2.0 app layer (qov-streaming-spec.md section 6): the receiver-side
// playback gate (freeze last good frame + refresh-band healing) and the
// sender-side adaptation ladder binding receiver reports to qov_set_quality /
// qov_drop_reference (spec v3.6 section 4.1).
using System.Diagnostics;

namespace QovLibrary.Streaming;

public enum QovPlaybackDecision
{
    // Decode and show.
    Display,
    // Decode into scratch state while the display stays frozen on the last
    // good frame (spec section 6 "freeze, don't glitch").
    Heal
}

// Chunk introspection for the receive path: QOV chunk wire layout is
// type(1) flags(1) size(4 BE) timestamp(4 BE) [uncompressedSize(4 BE) when
// compressed]; the refresh-band byte leads the payload when flagged.
public static class QovChunkInspector
{
    // QOV_INTRA_REFRESH_BANDS (spec v3.6 section 3.4.4): the rolling band
    // repaints the whole frame every 12 P-frames.
    public const int RefreshBandCycle = 12;

    public static (bool IsKeyframe, bool HasRefreshBand, int BandIndex) Inspect(ReadOnlySpan<byte> chunk, bool use32BitChunkSize = true)
    {
        byte type = chunk[0];
        byte flags = chunk[1];
        int headerSize = use32BitChunkSize ? 10 : 8;
        bool compressed = (flags & QovTypes.ChunkFlagCompressed) != 0;
        int bandOffset = headerSize + (compressed ? 4 : 0);
        bool hasBand = (flags & QovTypes.ChunkFlagRefreshBand) != 0 && chunk.Length > bandOffset;
        return (type == QovTypes.ChunkTypeKeyframe, hasBand, hasBand ? chunk[bandOffset] : -1);
    }
}

public class QovPlaybackGate
{
    private readonly int _keyframeRequestIntervalMs;
    private bool _healing;
    private int _bandsPainted;
    private bool _bandsInStream;
    private long _lastKeyframeRequestMs;

    public bool IsHealing => _healing;

    // Fired at most once per interval (spec section 2.2 caps server handling
    // at 1/s; the receiver self-limits the same way).
    public event Action? OnKeyframeRequest;

    public QovPlaybackGate(int keyframeRequestIntervalMs = 1000)
    {
        _keyframeRequestIntervalMs = keyframeRequestIntervalMs;
        // -interval, not long.MinValue: now - MinValue overflows and would
        // block the first request forever
        _lastKeyframeRequestMs = -keyframeRequestIntervalMs;
    }

    public QovPlaybackDecision OnFrameArrived(bool isKeyframe, bool hasRefreshBand)
    {
        if (hasRefreshBand) _bandsInStream = true;

        if (!_healing) return QovPlaybackDecision.Display;

        if (isKeyframe)
        {
            _healing = false;
            _bandsPainted = 0;
            return QovPlaybackDecision.Display;
        }
        if (hasRefreshBand)
        {
            _bandsPainted++;
            if (_bandsPainted >= QovChunkInspector.RefreshBandCycle)
            {
                _healing = false;
                _bandsPainted = 0;
                return QovPlaybackDecision.Display;
            }
            return QovPlaybackDecision.Heal;
        }
        RequestKeyframeIfNeeded();
        return QovPlaybackDecision.Heal;
    }

    public void OnFrameLost()
    {
        _healing = true;
        _bandsPainted = 0;
        if (!_bandsInStream) RequestKeyframeIfNeeded();
    }

    private void RequestKeyframeIfNeeded()
    {
        long now = Environment.TickCount64;
        if (now - _lastKeyframeRequestMs < _keyframeRequestIntervalMs) return;
        _lastKeyframeRequestMs = now;
        OnKeyframeRequest?.Invoke();
    }
}

// Adaptation ladder (spec section 6). Adaptation is by subtraction: only
// remove work (frames, coefficients, references), never add machinery.
public class QovAdaptationController
{
    private readonly int _startQuality;
    private readonly long _qualityChangeCooldownMs;
    private double _quality;
    private int _fecGroupSize = 4;
    private int _highLossStreak;
    private int _surplusStreak;
    private bool _skipActive;
    private bool _skipToggle;
    private double _rttEma = -1;
    private long _lastQualityChangeMs;

    public int CurrentQuality => (int)Math.Round(_quality);
    public int FecGroupSize => _fecGroupSize;
    public bool FrameSkipActive => _skipActive;
    public double RttEmaMs => _rttEma;

    public Action<int>? QualityChanged;  // binds encoder.SetQuality (qov_set_quality)
    public Action? ReferenceDropped;     // binds encoder.DropReference (qov_drop_reference)

    public QovAdaptationController(int startQuality = 60, int qualityChangeCooldownMs = 1000)
    {
        _startQuality = Math.Clamp(startQuality, 20, 99);
        _quality = _startQuality;
        _qualityChangeCooldownMs = qualityChangeCooldownMs;
        // -cooldown, not long.MinValue: now - MinValue overflows and would
        // block the first change forever
        _lastQualityChangeMs = -qualityChangeCooldownMs;
    }

    // Frame-skip knob while the playout buffer drains (spec section 6): skip
    // every other frame.
    public bool ShouldSkipFrame()
    {
        if (!_skipActive) return false;
        _skipToggle = !_skipToggle;
        return _skipToggle;
    }

    // One receiver report (spec section 2.2 REPORT, every 500 ms).
    // deliveredRatio = media bytes delivered / media bytes sent over the
    // report interval (1.0 = the channel carries everything we emit).
    public void OnReport(double lossPercent, double rttMs, double bufferMs, double frameIntervalMs, double deliveredRatio)
    {
        // FEC ratio (spec section 5.2): none below 0.5% loss, 1:3 above 2%.
        _fecGroupSize = lossPercent < 0.5 ? 0 : lossPercent > 2.0 ? 3 : 4;

        // Buffer draining (< 2 frame intervals) under real channel pressure
        // -> skip every other frame (a healthy loopback keeps a near-empty
        // buffer without needing to shed frames).
        if (frameIntervalMs > 0)
        {
            if (bufferMs < 2 * frameIntervalMs && deliveredRatio < 0.98) _skipActive = true;
            else if (bufferMs > 4 * frameIntervalMs || deliveredRatio >= 0.98) _skipActive = false;
        }

        // Sustained loss > 8% -> drop the reference; the next P-frame
        // re-keys the stream (spec v3.6 section 4.1).
        if (lossPercent > 8)
        {
            if (++_highLossStreak >= 3)
            {
                _highLossStreak = 0;
                ReferenceDropped?.Invoke();
            }
        }
        else
        {
            _highLossStreak = 0;
        }

        _rttEma = _rttEma < 0 ? rttMs : 0.8 * _rttEma + 0.2 * rttMs;

        // Bandwidth mapping: deficit -> q - 10 (floor 20); sustained surplus
        // (3 s = 3 consecutive clean reports) -> q + 10 (ceiling = start).
        if (deliveredRatio < 0.9)
        {
            _surplusStreak = 0;
            ChangeQuality(-10);
        }
        else if (lossPercent < 0.5 && deliveredRatio > 0.98)
        {
            if (++_surplusStreak >= 3)
            {
                _surplusStreak = 0;
                ChangeQuality(+10);
            }
        }
        else
        {
            _surplusStreak = 0;
        }
    }

    private void ChangeQuality(int delta)
    {
        long now = Environment.TickCount64;
        if (now - _lastQualityChangeMs < _qualityChangeCooldownMs) return;
        var next = Math.Clamp(_quality + delta, 20, _startQuality);
        if (next == _quality) return;
        _lastQualityChangeMs = now;
        _quality = next;
        QualityChanged?.Invoke(CurrentQuality);
    }
}
