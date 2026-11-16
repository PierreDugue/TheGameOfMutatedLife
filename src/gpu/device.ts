export interface GPU {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

/** An error whose message is meant to be shown to the user as is. */
export class UserError extends Error {}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPU> {
  if (!navigator.gpu) throw new UserError('This world needs WebGPU. Try a current Chrome, Edge or Safari.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new UserError('No WebGPU adapter found.');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + (e as GPUUncapturedErrorEvent).error.message));
  const context = canvas.getContext('webgpu');
  if (!context) throw new UserError('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  // COPY_SRC lets the renderer read a finished frame back for screenshots
  context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  return { device, context, format, canvas };
}

/** Creates a buffer initialised with `data` (size rounded up to 4 bytes). */
export function createBuffer(device: GPUDevice, data: ArrayBufferView<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer {
  const b = device.createBuffer({ size: Math.max(4, (data.byteLength + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
  return b;
}
