# QOV-S (Quite OK Video Streaming) Protocol Specification

**Version:** 1.0 (Draft)
**Date:** February 2026
**Transport:** Hybrid TCP/UDP

---

## 1. Overview

QOV-S is a streaming protocol designed to transport QOV video and audio data over a network. It prioritizes low latency by using UDP for media transport while maintaining stream stability and session management via a reliable TCP control channel.

**Architecture:**
*   **Control Channel (TCP):** Handles handshake, stream configuration, state changes (Play/Pause), and error recovery (Keyframe requests).
*   **Data Channel (UDP):** Handles the transmission of fragmented QOV chunks (Video/Audio).

---

## 2. Control Channel (TCP)

The control channel uses a simple text-based line protocol (UTF-8, terminated by `
`) or binary fixed structures for critical headers.

### 2.1 Connection Flow

1.  **Connect:** Client connects to Server TCP port (default: 8880).
2.  **Handshake:** Server sends the **QOV File Header** (24 or 32 bytes) immediately upon connection. This ensures the client has the sequence header (Width, Height, Version) to initialize the decoder.
3.  **Command Loop:** Client and Server exchange commands.

### 2.2 Commands

| Command | Direction | Description |
| :--- | :--- | :--- |
| `PLAY` | C -> S | Start sending UDP data. |
| `PAUSE` | C -> S | Stop sending UDP data. |
| `KEYFRAME` | C -> S | Request an immediate Keyframe (I-Frame). Used when packet loss causes artifacts. |
| `PING` | Both | Keep-alive. Responder must reply with `PONG`. |
| `PONG` | Both | Response to PING. |
| `BYE` | Both | Close connection. |

**Example Handshake:**
```text
[Client connects to TCP]
[Server sends 24-byte QOV Header binary data]
Client: PLAY
[Server starts UDP stream]
...
Client: KEYFRAME
[Server forces next frame to be I-Frame]
```

---

## 3. Data Channel (UDP)

The data channel transmits QOV chunks. Since QOV chunks (especially Keyframes) can exceed the network MTU, a simple fragmentation layer is introduced.

### 3.1 Packet Structure

Each UDP packet consists of a **16-byte header** followed by the payload. All integer fields are **Big-Endian**.

```
Offset  Size  Name            Description
──────────────────────────────────────────────────────────────
0       4     magic           Magic bytes "QOVP" (0x514F5650)
4       4     frame_id        Monotonic Frame ID. Increments per QOV Chunk.
8       2     fragment_id     Index of this fragment (0-based).
10      2     fragment_count  Total fragments for this Frame ID.
12      2     payload_size    Size of the data following this header.
14      1     packet_type     0x00=Video, 0x01=Audio, 0xF0=KeepAlive
15      1     reserved        Reserved (0x00)
16      N     payload         Fragment of the QOV Chunk.
```

### 3.2 Fragmentation Logic

**Sender (Server):**
1.  Generate a QOV Chunk (e.g., a 100KB Keyframe).
2.  Assign a `frame_id`.
3.  Split the chunk into `N` fragments, where each fragment payload size <= (MTU - 16).
    *   *Recommended Max Payload:* 1400 bytes (to stay within safe Ethernet MTU of 1500).
4.  Send `N` UDP packets with `fragment_id` from `0` to `N-1`.

**Receiver (Client):**
1.  Receive UDP packet.
2.  Check `frame_id`.
    *   If `frame_id` is new: Allocate buffer.
    *   If `frame_id` is old/completed: Discard.
3.  Place payload into buffer at offset `fragment_id * max_fragment_size` (Note: Receiver must handle variable sized last fragments correctly, ideally by simply concatenating sorted fragments).
4.  If all `fragment_count` packets are received:
    *   Pass the reassembled buffer to the QOV Decoder.
5.  **Timeout:** If a frame is incomplete after T milliseconds (e.g., 100ms), discard it.
    *   If the discarded frame was a Video packet, send `KEYFRAME` command over TCP to repair stream.

---

## 4. Recovery Strategy

Since UDP is unreliable:

1.  **Video:**
    *   If a **Keyframe** fragment is lost: The whole frame is corrupt. Decoder cannot initialize. Client MUST send `KEYFRAME` request.
    *   If a **P-Frame** fragment is lost: The frame is dropped. Subsequent P-frames will have visual artifacts. Client SHOULD send `KEYFRAME` request.
    *   *Optimization:* Client can tolerate a few dropped P-frames if the visual glitch is acceptable, but QOV's dependencies usually require a refresh.

2.  **Audio:**
    *   Audio chunks are small and usually fit in one packet.
    *   If lost: Audio gap. Client fills with silence or repeats last sample.

---

## 5. Security Considerations

*   **Authentication:** The TCP handshake can be extended to include an auth token before the QOV Header is sent.
*   **DoS:** Server should limit the rate of `KEYFRAME` requests to prevent encoder overload (e.g., max 1 per second).
