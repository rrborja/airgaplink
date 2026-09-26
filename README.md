# QR Directory Transfer

This monorepo has two optical transports. The established QR compatibility mode transfers a selected directory as a sequence of QR codes. The sender creates the ZIP in browser memory; archive bytes are never uploaded to the hosted sender service.

## Architecture

- **sender-ui** creates the ZIP in browser memory, splits it into 512-byte blocks, and continuously displays four binary QR codes at a time. It includes XOR parity after every eight source blocks.
- **sender-api** is safe to host. It sees an eight-character receiver session code, an opaque transfer code, and coarse FEC-group progress only. It never receives archive bytes, filenames, archive length, QR payloads, or per-frame acknowledgments.
- **receiver-ui** uses ZXing-C++ WebAssembly to decode up to four QR codes independently from a camera frame and forwards their raw bytes to the local receiver service.
- **receiver-api** stores binary frames locally, recovers one dropped source block per FEC group when parity is available, and batches coarse control updates to the sender API.
- **optical-core** contains the network-free custom frame, erasure-block, transfer-manifest, and acoustic-control codecs shared by both UIs.

## Transport modes

### QR Compatibility Mode

This is the existing four-QR transport. It uses the APIs described below strictly for compact control metadata; QR payload bytes are never sent to those APIs.

### High-Speed Optical — experimental file transfer and benchmark

The sender can choose **Transfer files** or **Link benchmark**. The receiver has matching receive and benchmark views. Both devices must select the same optical profile. The custom frame has:

- four concentric corner finder markers;
- redundant metadata containing protocol version, profile, frame ID, block ID, payload length, and CRC;
- calibration rails for binary, four-level luminance, or four-color symbols;
- a data grid with one of six manually selectable profiles: 100×60 binary, 200×120 binary, 300×180 four-level gray, 400×240 four-level gray, 300×180 RGB + black, or 200×120 RGB + black; and
- CRC16 header validation and CRC32 payload validation.

The sender renders through WebGL2 when available, with Canvas 2D fallback. The receiver captures camera frames into a worker, tracks the quadrilateral, samples symbol centres, and exports diagnostic metrics as JSON. A worker WebGL2 sampler is attempted and used only after it produces a CRC-valid camera frame; otherwise the measured Canvas path remains active. File mode makes a local ZIP, sends eight source plus two Reed–Solomon repair symbols per block, and cycles unacknowledged blocks. By default the sender constructs a ZIP in STORE mode directly from the selected files, reads it in small ranges, and avoids an archive-sized memory buffer. This supports archives below 4 GiB but does not compress them. Compressed staging on browser-private disk remains an optional mode where available. The receiver writes recovered blocks to browser-private disk or IndexedDB when available and offers a ZIP download only after its SHA-256 matches the sender's manifest. No file or camera bytes are passed to a network API.

The **RGB + black** profiles are experimental alternatives to the failing gray-level camera read: each two-bit payload symbol is exactly black, red, green, or blue. Each symbol occupies a 2×2 group of same-color physical cells; the reader samples the center of that group from the camera's full-resolution RGB image. This lowers density but reduces LCD-subpixel/Bayer color aliasing observed in the physical 200×120 test. Unused payload macrocells use a deterministic non-periodic color pattern. Color-reference rails at both edges of every data row let the reader account for camera white balance and illumination. The finder and metadata bands stay black/white for acquisition. Select the same profile on both devices; each has a distinct optical profile number, so older builds cannot pair with it. RGB carries two bits per macrocell, not additional bandwidth over four-level gray. The 200×120 option uses larger camera pixels per cell at the cost of lower per-frame capacity. Both require an RGB camera pixel path; the new macrocell layout still needs physical validation.

**Known limitation / future work:** RGB optical transfer remains slow and unstable in physical tests. Valid frame/header reads do not yet imply reliable end-to-end file delivery. The RGB path needs further camera/display calibration and physical throughput testing; do not treat it as production-ready. Current pacing work prioritizes measured optical goodput rather than a cosmetically low CRC-error percentage. Binary/direct optical and QR compatibility remain available.

RGB first-contact frames use a reserved `0xfe` frame-ID top byte to mark **five spatially separated copies** of the small optical handshake payload. Ordinary RGB data frames use three spatial copies. The receiver checks each copy against the optical CRC32, then tries bitwise majority if no individual copy passes. A CRC-failing RGB bootstrap frame with a valid metadata header is also retried at nearby sub-cell sampling positions. The 2×2 symbol footprint plus copies reduce effective RGB payload capacity to 500 bytes/frame at 200×120 and 1,125 bytes/frame at 300×180; binary/gray capacity and layout are unchanged. Optical CRC recovery yields the exact original bytes before Reed–Solomon/FEC processing. Both devices must reload the same build because earlier experimental RGB layouts are not wire-compatible with this macrocell layout.

If the receiver can read a current RGB offer header but not its payload, it can send an eight-tone `OPTICAL_QUALITY` control packet before pairing. Its four-byte payload is `[quality version=1, optical profile ID, CRC-failure reason=1, requested hold code=1 or 2]`; the normal acoustic envelope supplies the sequence, CRC16, and the compact session ID carried in that offer's optical header. A matching sender lengthens each displayed offer from 400 ms to 900 or 1500 ms. The encoded four-byte quality report is about 0.912 seconds of audio plus the existing short guard. This unauthenticated pre-pairing hint may **only slow display turnover**; it cannot authenticate a peer, change keys, or bypass SAS/key confirmation. After establishment, the existing authenticated-session routing, compact ACK pace reports, PAUSE/RESUME, and optical frame-rate calibration remain the runtime feedback loop. This correction path improves recovery opportunities but cannot guarantee a valid read through severe glare, defocus, clipping, or an unusable camera color signal.

High-Speed Optical file mode offers **Direct optical (existing)** and **Audio pairing + ACK**. In audio mode, the sender first displays a fresh cryptographic optical offer and the receiver responds over its speaker only after decoding that offer. The full session ID is derived from the 128-bit cryptographic ID for compact runtime routing; it is not the handshake’s entropy source. After the key-confirmation exchange, preparation cycles manifest block zero slowly while the camera is aligned. Once the receiver decodes a paired frame, it confirms the optical profile through sound. The sender then tests logical frame rates of 2, 4, 8, 15, 30, and 60 FPS up to the selected profile's display limit, spending three seconds at each rate. Calibration scores absolute CRC-valid delivery per second, discounted when too few distinct FEC shards arrive; it does not require a high percentage of all displayed frames to succeed. The receiver sends the selected rate through the unchanged compact acoustic packet, and file transmission starts automatically. During transfer, measured productive FEC and stored-ZIP throughput drive cautious one-step rate probes. Grid density remains manually selected on both devices.

### Secure audio-paired optical sessions

The audio-paired high-speed mode now begins with an offline authenticated key-agreement handshake. The directions are intentionally asymmetric:

```text
Optical direction:  Sender → Receiver
Acoustic direction: Receiver → Sender
```

```text
Sender                                      Receiver

generate X25519 key + nonce A
generate 128-bit session ID
        │ optical HANDSHAKE_OFFER
        │ sender public key, nonce A
        ├───────────────────────────────────>
        │                         generate X25519 key + nonce B
        │
        │  eight/four/two-tone fragmented acoustic response: receiver public key, nonce B,
        │  selected profile, capabilities, transcript binding
        <───────────────────────────────────
        │
        │ independently derive X25519 + HKDF session material
        │ display the same 9-digit SAS (for example 482-731-904)
        │
        │ optical KEY_CONFIRM (HMAC + authenticated audio-mode selection)
        ├───────────────────────────────────>
        │
        │ selected-mode authenticated acoustic READY confirmation
        <───────────────────────────────────
        │
        │ AES-256-GCM optical FEC blocks
        ├═══════════════════════════════════>
        │ selected-mode compact audio ACK/status packets (negotiated)
        <───────────────────────────────────
```

The AES session key is never transmitted. Both devices independently derive it from the ephemeral X25519 shared secret and handshake transcript.

Acoustic response fragments and READY parts change on-air order on retries. Their reassemblers accept out-of-order packets, so a speaker/microphone path that repeatedly loses the first or last packet position can still complete a later round without restarting pairing. After playing READY, the receiver displays `WAITING_FOR_SENDER`; it shows `ESTABLISHED` only after a session-matched optical file/alignment symbol proves that the sender advanced. This prevents a locally transmitted READY from being mistaken for a completed two-device handshake.

Both devices display a prominent **Codes match / Cancel** SAS check. Manually comparing and accepting the matching nine-digit codes provides about 30 bits of active-substitution detection; X25519 alone is never treated as identity authentication. The optional hands-free setting continues after three seconds without that comparison, so those sessions are encrypted but peer identity is unverified. Handshake packets are versioned binary structures, not JSON. The canonical transcript binds the protocol version, 128-bit session ID, both ephemeral public keys, both nonces, profile, and capabilities. Each acoustic fragment has the normal packet CRC, is bounded, duplicate-safe, expires after 180 seconds, and is additionally protected by the final transcript binding; fragments from distinct compact session IDs and tags do not combine.

The response is 108 bytes without optional device identity. It is fragmented into 18 ordinary 12-byte-or-smaller control packets with six content bytes each. The optical offer advertises separate eight- and four-tone capabilities for handshake and runtime control. Eight-tone FSK chooses one of 1000, 1250, 1500, 1750, 2000, 2250, 2500, or 2750 Hz for each three-bit, 16 ms Gray-mapped symbol; 250 Hz spacing is four cycles per symbol. A distinct 3250 Hz tone lasting 32 ms marks the start, followed by a three-byte preamble and the unchanged CRC16-protected normal or compact body. This is standard M-ary FSK: more bits per symbol require more bandwidth and may be less reliable on a particular acoustic path ([IEEE overview](https://technav.ieee.org/topic/frequency-shift-keying/)). The older four-tone mode uses 1300/1700/2100/2500 Hz, a 3100 Hz start tone, and a four-byte preamble. Both leave a 15 ms inter-packet guard. Two peers advertising eight-tone handshake and runtime support use **eight tones for every response retry, READY fragment, and runtime control packet**, including compact ACKs. The sender authenticates this locked mode in the optical `AHK2` key-confirmation frame; an `AHK2` downgrade is rejected. Four- or two-tone mode is used only when a peer does not advertise eight-tone support. Older receivers use the original `AHK1` confirmation. If an eight-tone acoustic path cannot be decoded, pairing remains pending rather than silently switching waveform.

The eight-tone response takes about 22.73 seconds of queued sound. Current peers separately negotiate a two-packet READY: each ordinary CRC16 packet has type `HANDSHAKE_COMPLETE`, the current compact transfer ID, a sequence number, and nine payload bytes `[part index: 1 byte, transcript-bound HMAC-SHA-256 half: 8 bytes]`. Both halves reconstruct a full 128-bit confirmation MAC; neither packet or its CRC is treated as authentication by itself. The sender accepts READY only after checking that MAC under the derived confirmation key and current transcript. Out-of-order and duplicate halves are safe, and incomplete pairs expire after 30 seconds. A complete two-packet READY takes about **2.27 seconds** of eight-tone sound including guards. It repeats until the receiver sees the sender's paired file/alignment frame. The full 128-bit cryptographic session ID is bound through the MAC input; the 32-bit acoustic ID only routes packets. Older eight-tone peers fall back to `AHY2`: a 24-byte, four-fragment READY with the same 128-bit authentication strength, taking about 5.05 seconds. Still older peers use the original 52-byte, nine-fragment `AHY1` READY (about 11.29 seconds at eight tones, or 17.14 seconds at four tones). The four-tone response is about 34.54 seconds. These are calculated waveform/scheduler times, **not measured physical delivery times**. An older two-tone exchange still takes roughly 80–90 seconds for the response and 35–45 seconds for READY. A receiver display of “0 remaining” means the last fragment or READY part has been queued for playback, not that the sender decoded it. Missing packets still trigger response or READY retransmission. The normal 12-byte packet limit and 14-byte compact ACK format remain unchanged.

Current sender and receiver builds can also negotiate the `FAST_OCTAL` capability bit (`0x80`) in the optical offer and acoustic response. It keeps the same eight frequencies, sync tone, binary packet layout, CRC16, 12-byte payload limit, and 14-byte compact ACK, but shortens **only eight-tone** symbols from 16 ms to 12 ms. The 250 Hz tone spacing then spans three cycles per symbol. The receiver uses the faster rate for every response fragment, READY part, and runtime status/ACK once the sender offers it; the sender listens at both eight-tone rates until it authenticates the response, then locks to the negotiated rate. The rate bit is covered by the cryptographic transcript. The sender’s “Faster 8-tone audio” control is off by default after physical Safari testing showed poor packet delivery at 12 ms; turn it on only for a proven acoustic path and start a fresh pairing. Peers lacking the bit stay at 16 ms. Synthetic waveform durations including existing guards are **17.19 seconds** for the 18-fragment response, **1.72 seconds** for the two-part READY, and **0.592 seconds** for a compact ACK, versus 22.73, 2.27, and 0.784 seconds at 16 ms. These are nominal airtimes, not a physical throughput guarantee: shorter symbols can increase errors or retries on reverberant, filtered, or noisy links. Human ability to distinguish notes is not the limiting requirement; the decoder must resolve tone energy and symbol timing.

After establishment, each plaintext FEC source block is encrypted once with AES-256-GCM, then Reed–Solomon symbols are generated from the exact ciphertext and tag. Repeated optical display uses cached ciphertext, never another encryption under the same nonce. Recovery therefore reconstructs the original authenticated ciphertext before GCM verification. The GCM IV is `sessionBindingKey[0..5] || blockId:uint32be || 0:uint16be`; block IDs are unique within the fresh per-transfer key. AAD contains protocol version, the full cryptographic session ID, legacy compact transfer ID, block ID, and encrypted-block frame type. Thus public routing headers remain decodable but their block-level meaning is authenticated. Direct optical and QR Compatibility Mode do not use this handshake and retain their prior behavior.

`optical-core` also exposes audited Ed25519 identity generation, signing, and verification helpers for a future IndexedDB-backed TOFU device directory. Persistent identity exchange is deliberately not enabled in this UI revision. To authenticate a peer, users must disable hands-free continuation and manually compare the SAS on every transfer; no identity key is silently trusted. A future UI must store private identity material only in IndexedDB, pin a SAS-confirmed peer public key, and force a fresh SAS warning if that key changes.

The optical manifest carries the archive length, block layout, and SHA-256. The sender repeats manifest block zero until the receiver stores it, then revisits a batch of four incomplete blocks and advances only after their ACKs. Block status uses a compact acoustic packet with the full session ID, sequence, cumulative first-missing block, four nearby receipt bits, a four-bit pacing recommendation, and CRC. A lost status tone is repaired by the next cumulative report. The 14-byte compact body is unchanged. Its synthetic waveform is 0.784 seconds plus a 15 ms guard in legacy 16 ms eight-tone mode (0.592 seconds with negotiated fast eight-tone audio), 1.20 seconds plus a 15 ms guard in four-tone mode, or 2.15 seconds plus a 100 ms guard in two-tone fallback. Runtime feedback can therefore be scheduled more frequently; the optical stream remains the only file-data plane. After initial calibration, a rolling five-second window counts newly collected FEC shards and ZIP bytes actually stored, not merely CRC-valid repeats or new display frame IDs. The receiver tests adjacent FPS codes and keeps a higher rate when productive bytes per second hold or improve. A high invalid-frame percentage alone cannot lower the rate; a genuine progress stall or a measured lower-rate trial can. The initial calibration choice is not a hard maximum. The sender requires two matching acoustic reports and a short hold interval before each step. The receiver shows camera-delivered FPS (when video-frame callbacks are supported), worker-processed FPS, new FEC KB/s, stored ZIP KB/s, and observed sender FPS. Camera capture requests at least 30 FPS when possible and falls back to an ideal 60 FPS request if that minimum is unsupported; actual delivery is measured separately. An optional short-exposure control is shown only when the camera reports both manual exposure and a way back to automatic exposure. It may darken the image, so it is never enabled automatically. Normal PAUSE, RESUME, profile, calibration, and completion control use the selected physical mode after establishment. After 12 seconds without a valid paired frame, the receiver sends PAUSE; reacquisition sends RESUME and incomplete blocks repeat. A new receive session gets a new ID. Acoustic packets contain no file bytes, filename, archive length, or network address. Browser permission rules require a click to start the speaker and microphone. Direct optical retains the previous behavior, and QR Compatibility Mode retains its eight-character key and network control path.

When supported, `requestVideoFrameCallback` drives receiver capture only when the camera delivers a new frame; other browsers retain the animation-frame fallback. Optical boundary tracking, pixel sampling, and CRC decoding remain in the existing dedicated worker, one frame at a time. Camera-delivered FPS versus worker-processed FPS exposes whether capture or decoding is the bottleneck; this is not yet a multi-worker decoder.

Physical Safari observation on the 200×120 binary profile showed the 73-byte optical key-confirmation frames decoding, but zero CRC-valid 2,992-byte alignment frames despite readable metadata. For this profile the sender now limits each FEC shard to 768 bytes (784 bytes including its optical-symbol header) without changing the wire format or AES/FEC ordering. It places three spatially separated copies of each payload in the existing data grid; the first copy remains in the original position so older receivers can still read it. The updated receiver tries each copy and a CRC-checked bitwise majority, then can also combine up to seven distinct noisy observations of a repeated shard. This trades peak bytes per frame for a better chance that complete ciphertext reaches FEC; the ideal 30-FPS source-shard ceiling is about 18 KB/s before retransmissions and storage overhead. The receiver keeps a trusted boundary longer when only payload CRC fails. Candidate bytes never reach FEC or decryption until their optical CRC matches. These improvements still need a measured end-to-end physical transfer test.

The sender opens in High-Speed Optical file mode. Its production UI is served as static files, without Vite's hot-reload WebSocket. The erasure-code WASM loads at startup; once the page says **Offline ready**, the loaded tab needs no further network access for High-Speed file transfer and acoustic control. The microphone worklet is bundled into the JavaScript. Keep the tab open when disconnecting networking. QR Compatibility Mode still uses the network control API when selected.

After SHA-256 verification, the receiver stops its camera, clears the sampled-frame preview, sends the completion tone three times, and turns off its speaker. When the sender hears completion, it stops its microphone, stops rendering, clears the optical display, and leaves full screen. The receiver never opens a microphone in this mode.

The optical file path has not yet passed a measured physical end-to-end throughput test. Multi-GB transfers have not been validated. The 300×180 and 400×240 four-level profiles use row-wise, left/right gray-reference calibration and a trimmed center sample when camera resolution permits; synthetic tests cover finder acquisition, blur at three camera pixels per cell, gamma shift, and uneven illumination. They have not been calibrated on real hardware. A blurred two-pixel-per-cell four-level frame still fails in simulation. If black and dark gray collapse to the same camera value, no decoder can restore the missing distinction; move closer, use larger cells, improve lighting/exposure, or use a binary profile on both devices. Their calculated raw capacity is not a measured transfer rate. The acoustic FPS calibration is also unverified on physical hardware; start with the 100×60 grid until the link is stable.

Safari Private Browsing does not provide the origin-private file system. The receiver tests IndexedDB as a second local block store, including a Blob write/read probe. If neither storage option works, it warns that reception is limited to 16 MiB in memory. Browser storage quota still limits the maximum ZIP size. A sender in Private Browsing uses the uncompressed, bounded-memory ZIP by default.

To try a local optical file transfer:

1. Open sender and receiver UIs and select **High-Speed Optical** on both. Select **Transfer files** and **Receive files** and match their optical profiles.
2. For audio pairing, select **Audio pairing + ACK** and the same optical profile on both devices. Select the sender directory **before** starting. On the receiver, click **Enable receiver speaker** and point its camera at the sender screen. On the sender, click **Start hands-free encrypted transfer**. This starts the microphone, requests full screen, displays the optical offer, and prepares the ZIP locally while the receiver sends its fragmented acoustic response. With two updated peers, the eight-tone response is approximately 23 seconds before retries; older peers use the four- or two-tone fallback. Browser microphone, speaker, and camera permissions may still require clicks.
3. Both devices display a pairing code. By default, hands-free mode continues after three seconds; this encrypts the session but **does not verify the peer's identity against a first-contact MITM**. For authenticated first pairing, turn off **Hands-free code continuation** on both devices before starting, compare the codes, and click **Codes match** on each only if they agree. A code mismatch requires cancellation and a new pairing. The sender automatically starts the ZIP transfer once acoustic READY establishes the session; no **Prepare ZIP** click is needed. Aim the camera at the slowly cycling alignment block. After sound confirms alignment, the sender tests frame rates for about 15–18 seconds, waits for the receiver's audio selection, and then starts file blocks automatically.
4. The optical frame sequence will rise, but the block number stays within the current four-block batch until the receiver confirms the stored bytes through sound. If the camera loses the frame, the sender pauses and resumes after the receiver reacquires it. The button remains available for manual pause/resume.
5. When the receiver displays **TRANSFER VERIFIED**, download its ZIP. The sender clears its display and turns off its microphone after hearing completion.

The compatibility QR transport remains available if this experimental path cannot decode reliably.

## Transfer protocol

1. The receiver opens the receiver UI and shares its eight-character session code with the sender.
2. The sender selects a directory. Client-side JavaScript compresses it, splits the ZIP into 512-byte blocks, and emits binary QR frames continuously at up to 32 frames per second.
3. Each frame carries a compact binary header and raw ZIP bytes in QR byte mode. No Base64 or JSON envelope is used in the QR code.
4. The receiver stores source blocks in any order, applies XOR parity to recover a single missing block in each eight-block group, and batches completed-group ranges every 500 ms.
5. The sender receives those ranges through its cookie-authenticated SSE stream and prioritizes incomplete groups for retransmission.

The QR frame contains the receiver session code, transfer code, frame kind, source/group position, archive block count, raw archive length, block length, and raw payload bytes. This binary frame is visible only in the optical transfer and is never sent to the sender API.

The sender UI subscribes to `/api/events`. This SSE URL carries neither a transfer code nor a secret. When a transfer is created, the sender API sets a one-hour opaque `HttpOnly`, `SameSite=Strict` cookie scoped to that endpoint; the cookie authorizes the event stream and does not contain archive data.

## Install and run

```bash
pnpm install
pnpm build:all
```

For the offline-capable sender, build and serve the static UI:

```bash
pnpm --filter sender-ui build
pnpm serve:sender-ui      # static sender UI, port 5173
pnpm dev:receiver-ui      # receiver UI, port 5174
```

The static sender serves build assets with ordinary finite HTTP responses. Its `/api` proxy is used only by QR Compatibility Mode. After the High-Speed page shows **Offline ready**, you can disconnect the sender's Wi-Fi, Ethernet, and Bluetooth while leaving the page open. `pnpm dev:sender-ui` also builds and serves this static UI; Vite's hot-reload server is available only through the explicit `pnpm --filter sender-ui dev:vite` command. Other development services remain:

```bash
pnpm dev:sender-api      # short-code metadata/control service, port 3001
pnpm dev:receiver-ui     # camera UI, port 5174
pnpm dev:receiver-api    # local receive/storage service, port 3002
```

Copy `.env.example` to `.env.local` as appropriate. Vite uses `VITE_SENDER_API_URL` and `VITE_RECEIVER_API_URL`. Configure the receiver API's `SENDER_API_URL` to point at the hosted sender API.

For a remote-device test, expose the sender UI and its `/api` proxy through one HTTPS tunnel. Start the receiver API on the receiving computer with `SENDER_API_URL=https://<sender-tunnel-host>`. The receiver API then sends only batched, coarse control metadata to that URL; scanned QR bytes stay on the receiving computer.

## Constraints

Directory picking uses the Chromium-compatible `webkitdirectory` input attribute. The QR compatibility ZIP still uses browser memory; the high-speed ZIP uses browser-private disk storage where available. The higher profiles require the display to occupy enough camera pixels per symbol and may perform poorly with rolling shutter or automatic exposure. In the physical 200×120 test, moving the display closer changed the result from zero to valid frames; throughput remains well below the 1 MB/s target. For offline optical operation, load both UIs and their local WASM assets before disabling networking; QR compatibility mode still needs its metadata services.
