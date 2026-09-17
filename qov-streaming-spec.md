# QOV-S (Quite OK Video Streaming) Protocol Specification

**Version:** 2.2
**Date:** September 2026
**Model:** carrier-agnostic — QOV-S is defined against two abstract channels
(a reliable control stream and a media path), so it runs over any protocol
stack that can provide them.
**Supersedes:** QOV-S v1.0 (Draft, February 2026) — session, packetization,
and loss machinery are upgraded in place; the classic TCP+UDP binding
continues unchanged as one supported carrier.

---

## 1. Overview

QOV-S transports QOV video (and QOA audio) chunks over a network with
interactive latency (target < 250 ms glass-to-glass). The protocol is split
into a **carrier-independent core** (this document's §2–§6: session,
packetization, chunk semantics, loss machinery, adaptation) and **carrier
bindings** (§7) that map the core onto a concrete protocol stack. New
carriers need no changes to the core.

### 1.1 Carrier Requirements

A carrier MUST provide:

1. **Control channel** — a reliable, ordered byte stream between the
   endpoints. (TCP, a QUIC stream, a WebSocket, a pipe, a serial line: any
   byte stream works.)
2. **Media channel** — one of:
   - **datagram mode**: unordered, unreliable datagrams with a known maximum
     payload (UDP, QUIC datagrams, DTLS, …). Full loss machinery (§5) is
     active; or
   - **stream mode**: the same reliable byte stream as the control channel.
     Loss machinery is idle; reliability is delegated to the carrier.

A binding additionally defines: how the two channels are established and
authenticated, and — in datagram mode — how the receiver's media address is
bound to the session (connect out, or learn from the first packet).

### 1.2 Known Bindings (informative)

| Binding | Media mode | Control runs over | Notes |
| :--- | :--- | :--- | :--- |
| **Classic** (reference: `csharp_qov/QovStreaming.cs`) | UDP datagrams | TCP | Native-to-native deployments; sockets are the natural API; protect with VPN/tunnel or DTLS (§7) |
| **WebSocket** | stream mode (`wss`) | same WebSocket | Proxy- and browser-friendly; loss machinery idle |
| **WebTransport** | QUIC datagrams | QUIC stream | Browser-grade HTTP/3 infrastructure; per-packet loss signals without head-of-line blocking |

Any other stack that satisfies §1.1 (raw QUIC, SCTP, Unix sockets for local
IPC, an in-process queue for tests) is a valid carrier.

## 2. Session

### 2.1 Connection Flow

1. Establish the control channel per the binding; client sends `HELLO`
   (auth token, protocol version).
2. Server validates and replies with `CONFIG` followed by the **QOV file
   header** (24/32 bytes, spec v3.6 §1) — the receiver initializes its
   decoder from it.
3. In datagram mode, the binding's media-address handshake completes (client
   connects its UDP flow, or sends one empty probe packet the server learns).
4. `PLAY` / media flows / `PAUSE` / `BYE`.

### 2.2 Control Messages

Text lines (UTF-8, `\n`-terminated) on the control channel. `k=v` arguments
after the verb.

| Message | Dir | Description |
| :--- | :--- | :--- |
| `HELLO token=T v=2` | C→S | Auth + protocol version. Server closes on mismatch. |
| `CONFIG` | S→C | Followed by the raw QOV file header bytes. |
| `PLAY` / `PAUSE` | C→S | Start/stop media flow. |
| `KEYFRAME` | C→S | Request immediate keyframe (rate-limited: server MUST cap at 1/s). |
| `REPORT loss=P rtt=US buf=MS since=SEQ` | C→S | Receiver report, every 500 ms (§6). |
| `NACK seq=A-B seq=C seq=D` | C→S | Missing datagram sequence numbers (§5.1). |
| `PING` / `PONG t=US` | both | Keep-alive + RTT measurement. |
| `BYE` | both | Close. |

## 3. Packetization

One page, one header, every carrier.

```
Offset  Size  Name            Description
──────────────────────────────────────────────────────────────
0       4     magic           "QOVP" (0x514F5650)
4       1     version         0x02
5       1     packet_type     0x00 video, 0x01 audio, 0x02 FEC (§5.2),
                              0x03 audio batch (§3.1, v2.1), 0xF0 keep-alive
6       4     seq             Monotonic datagram counter (loss detection)
10      4     frame_id        Monotonic QOV chunk counter (video+audio)
14      2     fragment_id     0-based fragment index within the frame
16      2     fragment_count  Total fragments for this frame
18      2     payload_size    Payload bytes following the header
20      N     payload         Fragment of the QOV chunk
```

All integers big-endian. In **datagram mode** every packet (header + payload)
MUST be ≤ 1200 bytes and fragment payloads ≤ 1180 — safe inside UDP and QUIC
datagrams on any common link. In **stream mode** senders SHOULD keep the same
fragmentation (one code path everywhere); a stream carrier MAY use larger
packets (the field allows 65535), and receivers MUST accept any declared
`payload_size` regardless of carrier. (v1.0's 16-byte header is retired; it
cannot carry `seq`, which §5 requires.)

**Sender:** split each QOV chunk (video keyframe/P-frame, or audio QOA frame)
into `ceil(len / frag_size)` fragments; emit one packet per fragment with a
shared `frame_id` and a per-file monotonic `seq` — or, for small audio
chunks, batch them per §3.1.

### 3.1 Audio Batching (NEW in v2.1, packet_type 0x03)

Small audio chunks are the dominant packet-count cost of a call (one
datagram per QOA frame ≈ 62 packets/s at 16 kHz). A sender MAY accumulate
consecutive complete AUDIO chunks into one **AudioBatch** packet:
`packet_type = 0x03`, `fragment_count = 1`, `payload` = a concatenation of
`[u16 length][AUDIO chunk bytes]` entries — the chunk header (type, codec
flags, size, timestamp) rides inside each entry unchanged.

Rules:

- Entries are complete AUDIO chunks only; the batch payload MUST stay ≤
  1180 bytes (datagram-mode fragment cap). Encoders flush the batch when
  full, when a video chunk is emitted (video `frame_id`s then stay above
  the batch's, so in-order delivery is preserved), or explicitly.
- The batch is ONE datagram for the whole machinery: one `seq`, one
  `frame_id` shared by all its chunks, never fragmented. NACK retransmits
  and replay cover it whole. XOR FEC (§5.2) MAY treat batch packets like
  any media packets; the reference senders do not group them (audio
  tolerates loss as gaps).
- Receivers split the entries on completion and deliver each chunk in
  order through the normal media path. A truncated trailing entry
  (corrupt datagram) is dropped. A `frame_id` whose only packet was lost
  is still a phantom hole (§6): the receiver learns the chunk count only
  on retransmit/receipt.
- v2.0 receivers ignore `packet_type` 0x03 (unknown), so senders can
  enable batching unilaterally on any carrier.
shared `frame_id`, incrementing `seq` across all packets. Fragments are sent
in order; the last one may be short. Audio frames typically fit one packet.

**Receiver:** buffer by `frame_id`; a frame is decodable when all
`fragment_count` fragments have arrived; assemble by `fragment_id` order
(concatenate payloads). In datagram mode, a frame whose fragments do not
arrive within its playback slot (one frame interval, hard cap 100 ms later)
is **dropped** — never decoded partially (§6).

## 4. Chunk Semantics

* Keyframes are self-contained; P-frames depend on the previously *decoded*
  frame. The QOV chunk flags (MOTION, DCT_BLOCKS, refresh bands, Exp-Golomb)
  pass through untouched — receivers use the ordinary QOV decoders.
* Senders SHOULD enable intra refresh bands (spec v3.6 §3.4.4) for camera
  content: a lost P-frame heals when the rolling band crosses it, without a
  full keyframe.
* Audio chunks are independent; loss only gaps audio (receivers fill silence
  or stretch the previous QOA frame).

## 5. Loss Recovery (datagram mode only)

### 5.1 NACK

The receiver detects gaps in `seq` and sends `NACK` immediately (coalescing a
500 ms window). The sender retransmits the listed datagrams if the frame is
still within its playback window; otherwise it ignores the NACK (the frame is
already dropped receiver-side).

### 5.2 XOR FEC

Senders MAY add parity packets over groups of consecutive media packets of
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
3. On a stream stall > 1 s: reconnect semantics — the sender MUST
   `qov_drop_reference()` and open with a keyframe, so stale prediction never
   leaks into the new state.

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

## 7. Carrier Bindings & Security

A binding is a short document (or code) answering three questions: how the
control channel is established, how the media channel is established and
address-bound (datagram mode), and how `HELLO` authenticates.

* **Classic (TCP + UDP):** control on a TCP stream (default port 8880); media
  datagrams from the client's UDP socket to the server's media port (default
  8881); the server binds the session to the first datagram source address.
  No TLS in the binding itself — protect with a VPN/tunnel, add DTLS as a
  future binding, or run inside a trusted network. `HELLO` token authenticates.
* **WebSocket:** everything over one `wss://` stream (stream mode). TLS via
  the carrier.
* **WebTransport:** `https://…/qovs`; media on QUIC datagrams, control on a
  bidirectional stream. TLS 1.3 required by the carrier.
* **WebRTC DataChannel (v2.2, static hosting):** media datagrams on an
  unordered lossy DataChannel (`ordered: false, maxRetransmits: 0`);
  control on a reliable ordered DataChannel. SDP offers/answers are
  exchanged out-of-band — copy-paste codes, QR, or any channel the peers
  trust — so the call works from a fully static site with no server
  component. STUN is allowed; TURN is not required by the binding.
  `HELLO` authenticates as in every other binding.
* Servers MUST rate-limit `KEYFRAME` (≤ 1/s) and drop clients exceeding it.

## 8. Changes from v1.0

* **v2.2 — WebRTC DataChannel carrier (§7)**: control on a reliable ordered
  DataChannel, media on an unordered lossy one; out-of-band copy-paste
  signaling makes the call demo deployable on any static site. Reference
  implementation: the call demo's peer-to-peer carrier. Reference
  implementations of earlier bindings are unchanged.
* **v2.1 — audio batching (§3.1)**: new `packet_type` 0x03 carries
  multiple complete AUDIO chunks per datagram (`[u16 len][chunk]`
  entries, one `seq`/`frame_id` per batch). Cuts a speech call from ~62
  to ~8 audio packets/s and amortizes the 20-byte header (plus the
  carrier's own per-datagram overhead) across chunks. v2.0 receivers
  ignore the type, so adoption is sender-side and unilateral.
* **Carrier-agnostic core**: the session and packetization are defined
  against two abstract channels (§1.1); TCP+UDP, WebSocket, and
  WebTransport are bindings, and others can be added without touching the
  core. The v1.0 architecture continues as the Classic binding.
* Packet header: 16 → 20 bytes; added `version` and monotonic `seq`
  (required for NACK/FEC and the receiver report). `reserved` byte removed.
* Fragment target 1400 → 1180 bytes (1200-byte packet cap in datagram mode).
* Control: text protocol kept; added `HELLO`/`CONFIG`/`REPORT`/`NACK`;
  `KEYFRAME` is rate-limited and the recovery path of last resort (refresh
  bands first).
* Added the adaptation ladder binding receiver reports to
  `qov_set_quality` / `qov_drop_reference` (spec v3.6 §4.1).
