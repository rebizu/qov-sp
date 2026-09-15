# QOV-S (Quite OK Video Streaming) Protocol Specification

**Version:** 2.0
**Date:** September 2026
**Transports:** WebTransport (HTTP/3, QUIC datagrams) primary; WebSocket fallback
**Supersedes:** QOV-S v1.0 (Draft, February 2026 — hybrid TCP control + UDP data)

---

## 1. Overview

QOV-S transports QOV video (and QOA audio) chunks over a network with
interactive latency (target < 250 ms glass-to-glass). Version 2.0 replaces the
v1.0 split transport (TCP control + raw UDP media) with a single connection:

* **Primary: WebTransport** over HTTP/3. Media packets ride QUIC **unreliable
  datagrams** (no head-of-line blocking, no retransmission delay); session
  control rides a QUIC **stream** (reliable, ordered).
* **Fallback: WebSocket.** When WebTransport is unavailable (corporate
  proxies, old browsers), the identical session runs over one WebSocket:
  control messages and length-prefixed packets share the byte stream.
  Reliability is delegated to TCP — NACK/FEC logic is simply idle. No other
  difference; the packetization (§3) and session state machine (§2) are
  byte-identical.

Rationale for the change from v1.0: two sockets doubled the handshake and
NAT/state surface, TCP control could head-of-line-block behind nothing while
UDP flooded, and QUIC gives per-packet loss signals (§5) for free.

## 2. Session

### 2.1 Connection Flow

1. Client connects (WebTransport URL `https://host/qovs`, or
   `wss://host/qovs`).
2. Client sends `HELLO` (auth token, protocol version).
3. Server validates and replies with `CONFIG` carrying the **QOV file header**
   (24/32 bytes, spec v3.6 §1) — the receiver initializes its decoder from it.
4. `PLAY` / media flows / `PAUSE` / `BYE`.

### 2.2 Control Messages

Text lines (UTF-8, `\n`-terminated) on the reliable channel. `k=v` arguments
after the verb.

| Message | Dir | Description |
| :--- | :--- | :--- |
| `HELLO token=T v=2` | C→S | Auth + protocol version. Server closes on mismatch. |
| `CONFIG` | S→C | Followed by the raw QOV file header bytes on the stream. |
| `PLAY` / `PAUSE` | C→S | Start/stop media flow. |
| `KEYFRAME` | C→S | Request immediate keyframe (rate-limited: server MUST cap at 1/s). |
| `REPORT loss=P rtt=US buf=MS since=SEQ` | C→S | Receiver report, every 500 ms (§6). |
| `NACK seq=A-B seq=C seq=D` | C→S | Missing datagram sequence numbers (§5.1). |
| `PING` / `PONG t=US` | both | Keep-alive + RTT measurement. |
| `BYE` | both | Close. |

## 3. Packetization

One page, one header, both transports.

```
Offset  Size  Name            Description
──────────────────────────────────────────────────────────────
0       4     magic           "QOVP" (0x514F5650)
4       1     version         0x02
5       1     packet_type     0x00 video, 0x01 audio, 0x02 FEC (§5.2),
                              0xF0 keep-alive
6       4     seq             Monotonic datagram counter (loss detection)
10      4     frame_id        Monotonic QOV chunk counter (video+audio)
14      2     fragment_id     0-based fragment index within the frame
16      2     fragment_count  Total fragments for this frame
18      2     payload_size    Payload bytes following the header
20      N     payload         Fragment of the QOV chunk
```

All integers big-endian. **Every packet (header + payload) MUST be ≤ 1200
bytes** — safe inside QUIC datagrams without IP fragmentation on any common
link. (v1.0's 16-byte header is retired; the 16-byte layout cannot carry
`seq`, which the loss machinery in §5 requires.)

**Sender:** split each QOV chunk (video keyframe/P-frame, or audio QOA frame)
into `ceil(len / 1180)` fragments; emit one datagram per fragment with a
shared `frame_id`, incrementing `seq` across all packets. Fragments are sent
in order; the last one may be short. Audio frames typically fit one packet.

**Receiver:** buffer by `frame_id`; a frame is decodable when all
`fragment_count` fragments have arrived; assemble by `fragment_id` order
(concatenate payloads). A frame whose fragments do not arrive within its
playback slot (one frame interval, hard cap 100 ms later) is **dropped** —
never decoded partially (§6).

## 4. Chunk Semantics

* Keyframes are self-contained; P-frames depend on the previously *decoded*
  frame. The QOV chunk flags (MOTION, DCT_BLOCKS, refresh bands, Exp-Golomb)
  pass through untouched — receivers use the ordinary QOV decoders.
* Senders SHOULD enable intra refresh bands (spec v3.6 §3.4.4) for camera
  content: a lost P-frame heals when the rolling band crosses it, without a
  full keyframe.
* Audio chunks are independent; loss only gaps audio (receivers fill silence
  or stretch the previous QOA frame).

## 5. Loss Recovery (WebTransport/datagram path only)

### 5.1 NACK

The receiver detects gaps in `seq` and sends `NACK` immediately (coalescing a
500 ms window). The sender retransmits the listed datagrams if the frame is
still within its playback window; otherwise it ignores the NACK (the frame is
already dropped receiver-side).

### 5.2 XOR FEC

Senders MAY add parity datagrams over groups of consecutive media packets of
the **same frame**: group sizes 4 (light, `1:4`) or 3 (aggressive, `1:3`),
one XOR parity packet per group. Parity packets use `packet_type = 0x02`, the
group's first `seq` in the `seq` field, and payload = XOR of the group's
packets zero-padded to the longest. A receiver missing exactly one group
member reconstructs it; missing more → drop the frame (§6).

FEC ratio is adaptive: start at 1:4, move to 1:3 when the receiver report
shows loss > 2%, and to none below 0.5%.

## 6. Receive Path & Adaptation

**Freeze, don't glitch.** On an undecodable frame the receiver keeps
displaying the last good frame and waits. Recovery order:
1. If intra refresh bands are active: keep decoding subsequent frames into a
   scratch state; resume display when the rolling band has repainted the
   affected rows (at most one GOP segment).
2. Otherwise send `KEYFRAME` (≤ 1/s).
3. On a stream stall > 1 s: send `BYE`-and-reconnect semantics — the sender
   MUST `qov_drop_reference()` and open with a keyframe, so stale prediction
   never leaks into the new state.

**Receiver report** (`REPORT`, every 500 ms): packet loss %, RTT (from
PING/PONG), playout buffer depth, and the highest contiguous `seq`.
The sender maps the report onto its adaptation ladder, in order:

| Condition | Action |
| :--- | :--- |
| loss > 5% or RTT spike | FEC 1:3 |
| buffer draining (< 2 frame intervals) | skip every other frame (`frame skip`) |
| sustained loss > 8% after FEC | `qov_drop_reference()` + reconnect logic |
| bandwidth < current bitrate | `qov_set_quality(q − 10)`, floor q = 20 |
| bandwidth surplus > 20% for 3 s | `qov_set_quality(q + 10)`, ceiling = start quality |

Adaptation is **by subtraction**: never add machinery (B-frames, larger
motion search, second passes) mid-call; only remove work (frames, coefficients,
references).

## 7. Security

* WebTransport requires TLS 1.3 + a valid origin certificate; the `HELLO`
  token is an application-scoped capability (short-lived, single-use).
* Servers MUST rate-limit `KEYFRAME` (≤ 1/s) and drop clients exceeding it.
* Datagrams are authenticated by QUIC; no additional CRC. WebSocket fallback
  inherits TLS via `wss://`.

## 8. Changes from v1.0

* Transports: TCP+UDP hybrid → WebTransport primary, WebSocket fallback.
* Packet header: 16 → 20 bytes; added `version` and monotonic `seq`
  (required for NACK/FEC and the receiver report). `reserved` byte removed.
* Fragment target size 1400 → 1180 bytes (1200-byte packet cap).
* Control: text protocol kept on the reliable channel; added
  `HELLO`/`CONFIG`/`REPORT`/`NACK`; `KEYFRAME` is now rate-limited and the
  recovery path of last resort (refresh bands first).
* Added the adaptation ladder binding receiver reports to
  `qov_set_quality` / `qov_drop_reference` (spec v3.6 §4.1).
