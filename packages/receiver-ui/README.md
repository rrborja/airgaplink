# Receiver UI

React 19.2.8 application for capturing QR codes using device camera via WebRTC.

## Features

- Camera access via getUserMedia/WebRTC
- Real-time QR code detection using jsQR library
- Automatic acknowledgment to receiver-api
- Display of detected QR codes

## Development

```bash
pnpm dev
```

This will start the Vite dev server on `http://localhost:5174`

## Building

```bash
pnpm build
```

This will create the production build in the `dist` directory.
