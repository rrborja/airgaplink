export interface CameraModeRequest { width: number; height: number; fps: number }

// A 1080p iPhone diagnostic had a valid frame header but irrecoverable payload
// aliasing on the 320×180 grid. Prefer 1440p for that profile while keeping a
// bounded 1080p fallback; never request 4K-sized decode surfaces in Safari.
export function phoneCameraModes(dense: boolean): CameraModeRequest[] {
  return dense
    ? [{ width: 2560, height: 1440, fps: 60 }, { width: 2560, height: 1440, fps: 30 }, { width: 1920, height: 1080, fps: 60 }, { width: 1920, height: 1080, fps: 30 }]
    : [{ width: 1920, height: 1080, fps: 60 }, { width: 1920, height: 1080, fps: 30 }, { width: 1280, height: 720, fps: 60 }, { width: 1280, height: 720, fps: 30 }]
}
