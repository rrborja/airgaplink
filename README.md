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
- calibration rails for binary or four-level luminance;
- a data grid with one of four manually selectable profiles: 100×60 binary, 200×120 binary, 300×180 four-level, or 400×240 four-level; and
- CRC16 header validation and CRC32 payload validation.

The sender renders through WebGL2 when available, with Canvas 2D fallback. The receiver captures camera frames into a worker, tracks the quadrilateral, samples symbol centres, and exports diagnostic metrics as JSON. A worker WebGL2 sampler is attempted and used only after it produces a CRC-valid camera frame; otherwise the measured Canvas path remains active. File mode makes a local ZIP, sends eight source plus two Reed–Solomon repair symbols per block, and cycles unacknowledged blocks. By default the sender constructs a ZIP in STORE mode directly from the selected files, reads it in small ranges, and avoids an archive-sized memory buffer. This supports archives below 4 GiB but does not compress them. Compressed staging on browser-private disk remains an optional mode where available. The receiver writes recovered blocks to browser-private disk or IndexedDB when available and offers a ZIP download only after its SHA-256 matches the sender's manifest. No file or camera bytes are passed to a network API.

High-Speed Optical file mode offers **Direct optical (existing)** and **Audio pairing + ACK**. In audio mode, the receiver generates a random session ID and repeats HELLO through its speaker. HELLO also carries one byte indicating whether local storage is available, so the sender can reject archives above the receiver's 16 MiB memory limit before transmission. The sender listens through its microphone and puts that ID into optical frames. Preparation cycles manifest block zero slowly while the camera is aligned. Once the receiver decodes a paired frame, it confirms the optical profile through sound. The sender then tests logical frame rates of 2, 4, 8, 15, 30, and 60 FPS up to the selected profile's display limit, spending three seconds at each rate. The receiver counts unique CRC-valid frames and selects the fastest stage with sufficient delivery. It sends that selection through a compact acoustic packet, and file transmission starts automatically. During transfer, sustained audio quality reports adjust the frame hold with hysteresis. Grid density remains manually selected on both devices.

The optical manifest carries the archive length, block layout, and SHA-256. The sender repeats manifest block zero until the receiver stores it, then revisits a batch of four incomplete blocks and advances only after their ACKs. Block status uses a compact acoustic packet with the full session ID, sequence, cumulative first-missing block, four nearby receipt bits, a four-bit pacing recommendation, and CRC. A lost status tone is repaired by the next cumulative report. The 16 ms FSK symbols remain unchanged; the synthetic compact packet duration is 2.15 seconds rather than 3.43 seconds for the earlier status format. After 12 seconds without a valid paired frame, the receiver sends PAUSE; reacquisition sends RESUME and incomplete blocks repeat. A new receive session gets a new ID. Acoustic packets contain no file bytes, filename, archive length, or network address. Browser permission rules require a click to start the speaker and microphone. Direct optical retains the previous behavior, and QR Compatibility Mode retains its eight-character key and network control path.

The sender opens in High-Speed Optical file mode. Its production UI is served as static files, without Vite's hot-reload WebSocket. The erasure-code WASM loads at startup; once the page says **Offline ready**, the loaded tab needs no further network access for High-Speed file transfer and acoustic control. The microphone worklet is bundled into the JavaScript. Keep the tab open when disconnecting networking. QR Compatibility Mode still uses the network control API when selected.

After SHA-256 verification, the receiver stops its camera, clears the sampled-frame preview, sends the completion tone three times, and turns off its speaker. When the sender hears completion, it stops its microphone, stops rendering, clears the optical display, and leaves full screen. The receiver never opens a microphone in this mode.

The optical file path has not yet passed a measured physical end-to-end throughput test. Multi-GB transfers have not been validated. The 300×180 and 400×240 profiles pass synthetic image tests but have not been calibrated on real hardware. Their calculated raw capacity is not a measured transfer rate. The acoustic FPS calibration is also unverified on physical hardware; start with the 100×60 grid until the link is stable.

Safari Private Browsing does not provide the origin-private file system. The receiver tests IndexedDB as a second local block store, including a Blob write/read probe. If neither storage option works, it warns that reception is limited to 16 MiB in memory. Browser storage quota still limits the maximum ZIP size. A sender in Private Browsing uses the uncompressed, bounded-memory ZIP by default.

To try a local optical file transfer:

1. Open sender and receiver UIs and select **High-Speed Optical** on both. Select **Transfer files** and **Receive files** and match their optical profiles.
2. For audio pairing, select **Audio pairing + ACK** on both. Click **Start audio handshake + feedback** on the receiver, then **Listen for audio pairing** on the sender. Wait for the same session ID to appear on both devices.
3. Select a directory on the sender and click **Prepare ZIP**. Aim the camera at the slowly cycling alignment block and select **Full screen** if needed. After sound confirms alignment, the sender tests frame rates for about 15–18 seconds, waits for the receiver's audio selection, and then starts file blocks automatically.
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
