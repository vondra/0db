// Web Worker entry: stateless palette compose — energy-sum + palette-map runs
// off the UI thread. Input arrives structured-cloned ({id, grids, width,
// height}); the composed pixels transfer back zero-copy. All session state
// and fallback logic live in the client (compose-off-thread.ts).

import { composeToImageData } from './hm3-compose'

type ComposeRequest = { id: number; grids: Uint8Array[]; width: number; height: number }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ComposeRequest>) => void) | null
  postMessage: (msg: unknown, transfer: Transferable[]) => void
}

ctx.onmessage = (e) => {
  const { id, grids, width, height } = e.data
  const image = composeToImageData(grids, width, height)
  ctx.postMessage({ id, pixels: image.data.buffer, width, height }, [image.data.buffer])
}
