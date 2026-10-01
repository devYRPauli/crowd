/**
 * The browser would not give the viewport a WebGL 2 context: hardware
 * acceleration is off, the GPU is blocklisted, or the browser is too old.
 * Nothing the editor does can fix that, so the crash screen says so instead
 * of offering a reload that fails the same way.
 */
export class WebGLUnavailableError extends Error {
  constructor(cause: unknown) {
    super('This browser could not create a WebGL 2 context.', { cause })
    this.name = 'WebGLUnavailableError'
  }
}
