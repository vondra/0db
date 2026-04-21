type SupervisorLogLevel = 'info' | 'warn' | 'error'

export type NoiseOnflyWorkerReply = {
  id: number
  ok: boolean
  resultJson?: string
  error?: string
}

export type NoiseOnflyOp = 'point' | 'unfiltered'

export interface NoiseOnflyWorker {
  postMessage(message: { id: number; lat: number; lng: number; op?: NoiseOnflyOp }): void
  terminate(): Promise<number>
  on(event: 'message', listener: (message: NoiseOnflyWorkerReply) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
}

export type NoiseOnflyWorkerFactory = () => NoiseOnflyWorker

type SupervisorLogger = (
  level: SupervisorLogLevel,
  message: string,
  meta?: Record<string, unknown>
) => void

export class NoiseOnflyRequestError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(message: string, code: string, statusCode: number) {
    super(message)
    this.name = 'NoiseOnflyRequestError'
    this.code = code
    this.statusCode = statusCode
  }
}

type RequestEntry = {
  id: number
  lat: number
  lng: number
  op: NoiseOnflyOp
  resolve: (resultJson: string) => void
  reject: (err: Error) => void
  queueTimer: NodeJS.Timeout | null
  workTimer: NodeJS.Timeout | null
  worker: NoiseOnflyWorker | null
  signal?: AbortSignal
  abortHandler?: () => void
  clientSettled: boolean
}

export type NoiseOnflySupervisorConfig = {
  createWorker: NoiseOnflyWorkerFactory
  maxQueue: number
  queueTimeoutMs: number
  workTimeoutMs: number
  logger?: SupervisorLogger
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(): Error {
  const error = new Error('noise-onfly request aborted')
  error.name = 'AbortError'
  return error
}

function queueFullError(): NoiseOnflyRequestError {
  return new NoiseOnflyRequestError('noise-onfly busy', 'NOISE_ONFLY_BUSY', 503)
}

function queueTimeoutError(queueTimeoutMs: number): NoiseOnflyRequestError {
  return new NoiseOnflyRequestError(
    `noise-onfly queue timeout after ${queueTimeoutMs} ms`,
    'NOISE_ONFLY_QUEUE_TIMEOUT',
    503,
  )
}

function workTimeoutError(workTimeoutMs: number): NoiseOnflyRequestError {
  return new NoiseOnflyRequestError(
    `noise-onfly timeout after ${workTimeoutMs} ms`,
    'NOISE_ONFLY_TIMEOUT',
    504,
  )
}

function unavailableError(message: string): NoiseOnflyRequestError {
  return new NoiseOnflyRequestError(message, 'NOISE_ONFLY_UNAVAILABLE', 503)
}

export class NoiseOnflySupervisor {
  private readonly createWorker: NoiseOnflyWorkerFactory
  private readonly maxQueue: number
  private readonly queueTimeoutMs: number
  private readonly workTimeoutMs: number
  private readonly logger?: SupervisorLogger

  private worker: NoiseOnflyWorker | null = null
  private recyclingWorker: NoiseOnflyWorker | null = null
  private recycling: Promise<void> | null = null
  private active: RequestEntry | null = null
  private readonly queue: RequestEntry[] = []
  private nextRequestId = 1
  private closed = false

  constructor(config: NoiseOnflySupervisorConfig) {
    this.createWorker = config.createWorker
    this.maxQueue = Math.max(0, config.maxQueue)
    this.queueTimeoutMs = Math.max(1, config.queueTimeoutMs)
    this.workTimeoutMs = Math.max(1, config.workTimeoutMs)
    this.logger = config.logger
  }

  async queryNoiseAtPoint(lat: number, lng: number, signal?: AbortSignal): Promise<string> {
    return this.enqueue(lat, lng, 'point', signal)
  }

  async queryNoiseAtPointUnfiltered(lat: number, lng: number, signal?: AbortSignal): Promise<string> {
    return this.enqueue(lat, lng, 'unfiltered', signal)
  }

  private async enqueue(lat: number, lng: number, op: NoiseOnflyOp, signal?: AbortSignal): Promise<string> {
    if (this.closed) {
      throw unavailableError('noise-onfly supervisor is shutting down')
    }
    if (this.queue.length >= this.maxQueue) {
      this.log('warn', 'noise-onfly queue full', {
        queue_length: this.queue.length,
        active_request_id: this.active?.id ?? null,
      })
      throw queueFullError()
    }

    return await new Promise<string>((resolve, reject) => {
      const entry: RequestEntry = {
        id: this.nextRequestId++,
        lat,
        lng,
        op,
        resolve,
        reject,
        queueTimer: null,
        workTimer: null,
        worker: null,
        signal,
        clientSettled: false,
      }

      if (signal?.aborted) {
        this.rejectClient(entry, abortError())
        return
      }

      if (signal) {
        entry.abortHandler = () => this.handleAbort(entry)
        signal.addEventListener('abort', entry.abortHandler, { once: true })
      }

      entry.queueTimer = setTimeout(() => {
        this.handleQueueTimeout(entry.id)
      }, this.queueTimeoutMs)

      this.queue.push(entry)
      this.log('info', 'noise-onfly queued request', {
        request_id: entry.id,
        queue_length: this.queue.length,
      })
      this.startNextIfPossible()
    })
  }

  async close(): Promise<void> {
    this.closed = true

    const shutdownError = unavailableError('noise-onfly supervisor is shutting down')
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!
      this.clearQueueTimer(entry)
      this.detachAbortListener(entry)
      this.rejectClient(entry, shutdownError)
    }

    const active = this.active
    this.active = null
    if (active) {
      this.clearWorkTimer(active)
      active.worker = null
      this.detachAbortListener(active)
      this.rejectClient(active, shutdownError)
    }

    if (this.recycling) {
      await this.recycling
    }

    const current = this.worker
    this.worker = null
    if (current) {
      try {
        await current.terminate()
      } catch {
        // ignore terminate failures during shutdown
      }
    }
  }

  private startNextIfPossible(): void {
    if (this.closed || this.active || this.recycling) {
      return
    }

    const entry = this.queue.shift()
    if (!entry) {
      return
    }

    if (entry.clientSettled) {
      queueMicrotask(() => this.startNextIfPossible())
      return
    }

    this.clearQueueTimer(entry)

    let worker: NoiseOnflyWorker
    try {
      worker = this.ensureWorker()
    } catch (error) {
      this.rejectClient(entry, unavailableError(`noise-onfly worker spawn failed: ${toError(error).message}`))
      queueMicrotask(() => this.startNextIfPossible())
      return
    }

    entry.worker = worker
    entry.workTimer = setTimeout(() => {
      void this.handleWorkTimeout(entry.id)
    }, this.workTimeoutMs)
    this.active = entry

    this.log('info', 'noise-onfly dispatched request', {
      request_id: entry.id,
      queue_length: this.queue.length,
    })

    try {
      worker.postMessage({ id: entry.id, lat: entry.lat, lng: entry.lng, op: entry.op })
    } catch (error) {
      this.finishActiveSlot(entry)
      this.rejectClient(entry, unavailableError(`noise-onfly dispatch failed: ${toError(error).message}`))
      void this.recycleWorker(worker, 'dispatch_failed')
    }
  }

  private ensureWorker(): NoiseOnflyWorker {
    if (this.worker) {
      return this.worker
    }

    const current = this.createWorker()
    current.on('message', (message) => {
      this.handleWorkerMessage(current, message)
    })
    current.on('error', (err) => {
      void this.handleWorkerError(current, err)
    })
    current.on('exit', (code) => {
      void this.handleWorkerExit(current, code)
    })

    this.worker = current
    this.log('info', 'noise-onfly worker spawned')
    return current
  }

  private handleWorkerMessage(current: NoiseOnflyWorker, message: NoiseOnflyWorkerReply): void {
    if (this.recyclingWorker === current) {
      return
    }

    const active = this.active
    if (!active || active.worker !== current) {
      this.log('warn', 'noise-onfly received stray worker message', {
        request_id: message.id,
      })
      return
    }
    if (active.id !== message.id) {
      this.log('warn', 'noise-onfly worker reply id mismatch', {
        active_request_id: active.id,
        reply_request_id: message.id,
      })
      return
    }

    this.finishActiveSlot(active)
    if (message.ok && message.resultJson !== undefined) {
      this.resolveClient(active, message.resultJson)
    } else {
      this.rejectClient(
        active,
        new NoiseOnflyRequestError(
          message.error || 'noise-onfly worker failed',
          'NOISE_ONFLY_WORKER_FAILURE',
          500,
        ),
      )
    }
    queueMicrotask(() => this.startNextIfPossible())
  }

  private async handleWorkerError(current: NoiseOnflyWorker, err: Error): Promise<void> {
    if (this.recyclingWorker === current) {
      return
    }
    if (this.worker !== current && this.active?.worker !== current) {
      return
    }

    this.log('warn', 'noise-onfly worker error', {
      error: err.message,
      active_request_id: this.active?.id ?? null,
    })

    const active = this.active?.worker === current ? this.active : null
    if (active) {
      this.finishActiveSlot(active)
      this.rejectClient(active, unavailableError(`noise-onfly worker error: ${err.message}`))
    }

    await this.recycleWorker(current, 'worker_error')
  }

  private async handleWorkerExit(current: NoiseOnflyWorker, code: number): Promise<void> {
    if (this.recyclingWorker === current) {
      return
    }
    if (this.worker !== current && this.active?.worker !== current) {
      return
    }

    this.log(code === 0 ? 'info' : 'warn', 'noise-onfly worker exited', {
      exit_code: code,
      active_request_id: this.active?.id ?? null,
    })

    const active = this.active?.worker === current ? this.active : null
    if (active) {
      this.finishActiveSlot(active)
      this.rejectClient(
        active,
        unavailableError(`noise-onfly worker exited with code ${code}`),
      )
    }

    await this.recycleWorker(current, 'worker_exit', { skipTerminate: true })
  }

  private async handleWorkTimeout(requestId: number): Promise<void> {
    const active = this.active
    if (!active || active.id !== requestId) {
      return
    }
    const current = active.worker
    if (!current) {
      return
    }

    this.log('warn', 'noise-onfly request timed out', {
      request_id: active.id,
      queue_length: this.queue.length,
    })

    this.finishActiveSlot(active)
    this.rejectClient(active, workTimeoutError(this.workTimeoutMs))
    await this.recycleWorker(current, 'request_timeout')
  }

  private handleQueueTimeout(requestId: number): void {
    const queueIndex = this.queue.findIndex((entry) => entry.id === requestId)
    if (queueIndex === -1) {
      return
    }

    const [entry] = this.queue.splice(queueIndex, 1)
    this.clearQueueTimer(entry)
    this.detachAbortListener(entry)
    this.rejectClient(entry, queueTimeoutError(this.queueTimeoutMs))
    this.log('warn', 'noise-onfly queued request timed out', {
      request_id: requestId,
      queue_length: this.queue.length,
    })
  }

  private handleAbort(entry: RequestEntry): void {
    if (this.active?.id === entry.id) {
      this.detachAbortListener(entry)
      this.rejectClient(entry, abortError())
      this.log('info', 'noise-onfly active request aborted', {
        request_id: entry.id,
      })
      return
    }

    const queueIndex = this.queue.findIndex((candidate) => candidate.id === entry.id)
    if (queueIndex === -1) {
      return
    }

    this.queue.splice(queueIndex, 1)
    this.clearQueueTimer(entry)
    this.detachAbortListener(entry)
    this.rejectClient(entry, abortError())
    this.log('info', 'noise-onfly queued request aborted', {
      request_id: entry.id,
      queue_length: this.queue.length,
    })
  }

  private async recycleWorker(
    current: NoiseOnflyWorker,
    reason: string,
    options: { skipTerminate?: boolean } = {},
  ): Promise<void> {
    if (this.recycling) {
      return await this.recycling
    }

    if (this.worker === current) {
      this.worker = null
    }
    this.recyclingWorker = current
    this.log('warn', 'noise-onfly recycling worker', {
      reason,
      queue_length: this.queue.length,
    })

    this.recycling = (async () => {
      if (!options.skipTerminate) {
        try {
          await current.terminate()
        } catch (error) {
          this.log('warn', 'noise-onfly worker terminate failed', {
            reason,
            error: toError(error).message,
          })
        }
      }
    })().finally(() => {
      if (this.recyclingWorker === current) {
        this.recyclingWorker = null
      }
      this.recycling = null
      this.log('info', 'noise-onfly worker recycle complete', {
        queue_length: this.queue.length,
      })
      this.startNextIfPossible()
    })

    await this.recycling
  }

  private finishActiveSlot(entry: RequestEntry): void {
    if (this.active?.id === entry.id) {
      this.active = null
    }
    this.clearWorkTimer(entry)
    entry.worker = null
    this.detachAbortListener(entry)
  }

  private clearQueueTimer(entry: RequestEntry): void {
    if (entry.queueTimer) {
      clearTimeout(entry.queueTimer)
      entry.queueTimer = null
    }
  }

  private clearWorkTimer(entry: RequestEntry): void {
    if (entry.workTimer) {
      clearTimeout(entry.workTimer)
      entry.workTimer = null
    }
  }

  private detachAbortListener(entry: RequestEntry): void {
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler)
      entry.abortHandler = undefined
    }
  }

  private resolveClient(entry: RequestEntry, resultJson: string): void {
    if (entry.clientSettled) {
      return
    }
    entry.clientSettled = true
    this.detachAbortListener(entry)
    entry.resolve(resultJson)
  }

  private rejectClient(entry: RequestEntry, err: Error): void {
    if (entry.clientSettled) {
      return
    }
    entry.clientSettled = true
    this.detachAbortListener(entry)
    entry.reject(err)
  }

  private log(level: SupervisorLogLevel, message: string, meta?: Record<string, unknown>): void {
    this.logger?.(level, message, meta)
  }
}
