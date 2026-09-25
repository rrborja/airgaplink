import { frameDimensions, transformForBoundary, type OpticalBoundary, type OpticalImage, type OpticalProfile } from '@qrcopy/optical-core'

/** GPU perspective sampling: one output pixel per logical optical cell. */
export class GpuOpticalSampler {
  private readonly gl: WebGL2RenderingContext
  private readonly source: WebGLTexture
  private readonly target: WebGLTexture
  private readonly framebuffer: WebGLFramebuffer
  private readonly program: WebGLProgram
  private readonly rowX: WebGLUniformLocation
  private readonly rowY: WebGLUniformLocation
  private readonly rowW: WebGLUniformLocation
  private readonly cameraSize: WebGLUniformLocation
  private output = new Uint8Array(0)
  private width = 0
  private height = 0

  constructor() {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false })
    if (!gl) throw new Error('Worker WebGL2 unavailable')
    this.gl = gl
    const shader = (kind: number, source: string) => {
      const value = gl.createShader(kind); if (!value) throw new Error('GPU shader unavailable')
      gl.shaderSource(value, source); gl.compileShader(value)
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) || 'GPU shader failed')
      return value
    }
    const vertex = shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }')
    const fragment = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; uniform sampler2D camera; uniform vec3 rowX; uniform vec3 rowY; uniform vec3 rowW; uniform vec2 cameraSize; out vec4 color; void main() { vec3 p = vec3(gl_FragCoord.xy, 1.0); float divisor = dot(rowW, p); vec2 source = vec2(dot(rowX, p), dot(rowY, p)) / divisor; color = texture(camera, (source + vec2(0.5)) / cameraSize); }')
    const program = gl.createProgram(); if (!program) throw new Error('GPU program unavailable')
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'GPU program failed')
    gl.deleteShader(vertex); gl.deleteShader(fragment); gl.useProgram(program)
    this.program = program
    const location = (name: string) => { const value = gl.getUniformLocation(program, name); if (!value) throw new Error(`Missing GPU uniform ${name}`); return value }
    this.rowX = location('rowX'); this.rowY = location('rowY'); this.rowW = location('rowW'); this.cameraSize = location('cameraSize')
    const vertexBuffer = gl.createBuffer(); if (!vertexBuffer) throw new Error('GPU vertex buffer unavailable')
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const attribute = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)
    const source = gl.createTexture(), target = gl.createTexture(), framebuffer = gl.createFramebuffer()
    if (!source || !target || !framebuffer) throw new Error('GPU texture unavailable')
    this.source = source; this.target = target; this.framebuffer = framebuffer
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(program, 'camera'), 0)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.bindTexture(gl.TEXTURE_2D, target)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
  }

  sample(bitmap: ImageBitmap, boundary: OpticalBoundary, profile: OpticalProfile): OpticalImage {
    const transform = transformForBoundary(boundary, profile)
    if (!transform) throw new Error('Optical perspective transform failed')
    const gl = this.gl, dimensions = frameDimensions(profile)
    if (dimensions.width !== this.width || dimensions.height !== this.height) {
      this.width = dimensions.width; this.height = dimensions.height
      this.output = new Uint8Array(this.width * this.height * 4)
      gl.bindTexture(gl.TEXTURE_2D, this.target)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Optical GPU framebuffer unavailable')
    }
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.viewport(0, 0, this.width, this.height)
    gl.uniform3f(this.rowX, transform[0], transform[1], transform[2])
    gl.uniform3f(this.rowY, transform[3], transform[4], transform[5])
    gl.uniform3f(this.rowW, transform[6], transform[7], transform[8])
    gl.uniform2f(this.cameraSize, bitmap.width, bitmap.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.output)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Optical GPU readback failed')
    return { data: new Uint8ClampedArray(this.output.buffer), width: this.width, height: this.height }
  }
}
