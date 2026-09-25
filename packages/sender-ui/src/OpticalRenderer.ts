import { writeOpticalCellRgba, type EncodedOpticalFrame, type OpticalProfile } from '@qrcopy/optical-core'

/** Change symbols at animation boundaries, while preserving a minimum hold. */
export function scheduleOpticalFrames(profile: OpticalProfile, draw: () => void, logicalFps = () => profile.targetDisplayFps / profile.frameHoldCount) {
  let last = performance.now(), animation = 0
  draw()
  const tick = (now: number) => {
    const holdMs = 1000 / Math.max(1, logicalFps())
    if (now - last >= holdMs - 1) { last = now; draw() }
    animation = requestAnimationFrame(tick)
  }
  animation = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(animation)
}

/** React owns lifecycle; this renderer owns reusable WebGL2 or Canvas buffers. */
export class OpticalRenderer {
  private readonly logicalCanvas: HTMLCanvasElement
  private logicalContext: CanvasRenderingContext2D | null = null
  private image: ImageData | null = null
  private gl: WebGL2RenderingContext | null = null
  private texture: WebGLTexture | null = null
  private program: WebGLProgram | null = null
  private rgbLocation: WebGLUniformLocation | null = null
  private pixels = new Uint8Array(0)
  private textureWidth = 0
  private textureHeight = 0
  private textureRgb = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.logicalCanvas = document.createElement('canvas')
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false })
    if (this.gl) this.prepareWebGl(this.gl)
  }

  private prepareWebGl(gl: WebGL2RenderingContext) {
    const shader = (kind: number, source: string) => { const value = gl.createShader(kind); if (!value) throw new Error('WebGL shader unavailable'); gl.shaderSource(value, source); gl.compileShader(value); if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) || 'WebGL shader failed'); return value }
    const vertex = shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 position; out vec2 uv; void main() { uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5); gl_Position = vec4(position, 0.0, 1.0); }')
    const fragment = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; in vec2 uv; uniform sampler2D symbols; uniform bool rgbMode; out vec4 color; void main() { vec4 symbol = texture(symbols, uv); color = rgbMode ? symbol : vec4(symbol.rrr, 1.0); }')
    const program = gl.createProgram(); if (!program) throw new Error('WebGL program unavailable')
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL link failed')
    gl.deleteShader(vertex); gl.deleteShader(fragment); gl.useProgram(program); this.program = program
    this.rgbLocation = gl.getUniformLocation(program, 'rgbMode')
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const location = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  }

  render(frame: EncodedOpticalFrame) {
    const frameRatio = frame.width / frame.height
    const availableWidth = Math.max(640, window.innerWidth * 0.94), availableHeight = Math.max(420, window.innerHeight * 0.72)
    const targetWidth = Math.floor(Math.min(availableWidth, availableHeight * frameRatio)), targetHeight = Math.floor(targetWidth / frameRatio)
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) { this.canvas.width = targetWidth; this.canvas.height = targetHeight }
    if (this.gl && this.program && this.texture) {
      const gl = this.gl
      const rgb = frame.profile.colorMode === 'rgb'
      if (this.pixels.length !== frame.cells.length * (rgb ? 4 : 1)) this.pixels = new Uint8Array(frame.cells.length * (rgb ? 4 : 1))
      if (rgb) for (let index = 0; index < frame.cells.length; index += 1) writeOpticalCellRgba(frame, index, this.pixels, index * 4)
      else { const multiplier = frame.profile.bitsPerSymbol === 2 ? 85 : 255; for (let index = 0; index < frame.cells.length; index += 1) this.pixels[index] = frame.cells[index] * multiplier }
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      const format = rgb ? gl.RGBA : gl.RED
      if (this.textureWidth !== frame.width || this.textureHeight !== frame.height || this.textureRgb !== rgb) {
        this.textureWidth = frame.width; this.textureHeight = frame.height; this.textureRgb = rgb
        gl.texImage2D(gl.TEXTURE_2D, 0, rgb ? gl.RGBA8 : gl.R8, frame.width, frame.height, 0, format, gl.UNSIGNED_BYTE, this.pixels)
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, format, gl.UNSIGNED_BYTE, this.pixels)
      gl.uniform1i(this.rgbLocation, rgb ? 1 : 0)
      gl.viewport(0, 0, targetWidth, targetHeight); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return
    }
    if (!this.logicalContext || this.logicalCanvas.width !== frame.width || this.logicalCanvas.height !== frame.height) {
      this.logicalCanvas.width = frame.width; this.logicalCanvas.height = frame.height
      this.logicalContext = this.logicalCanvas.getContext('2d', { alpha: false })
      this.image = this.logicalContext?.createImageData(frame.width, frame.height) || null
    }
    const context = this.logicalContext, image = this.image
    if (!context || !image) return
    for (let index = 0; index < frame.cells.length; index += 1) {
      writeOpticalCellRgba(frame, index, image.data, index * 4)
    }
    context.putImageData(image, 0, 0)
    const output = this.canvas.getContext('2d', { alpha: false }); if (!output) return
    output.imageSmoothingEnabled = false; output.fillStyle = '#fff'; output.fillRect(0, 0, targetWidth, targetHeight)
    output.drawImage(this.logicalCanvas, 0, 0, targetWidth, targetHeight)
  }

  clear() {
    if (this.gl) {
      this.gl.clearColor(1, 1, 1, 1)
      this.gl.clear(this.gl.COLOR_BUFFER_BIT)
    } else {
      const context = this.canvas.getContext('2d')
      if (context) { context.fillStyle = '#fff'; context.fillRect(0, 0, this.canvas.width, this.canvas.height) }
    }
  }
}
