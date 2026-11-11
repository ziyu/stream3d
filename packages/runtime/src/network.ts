import type { NetworkDiagnostics } from './types.js';

/** Fixed-size counters only. Request bodies are retained solely while assembling their result. */
export class NetworkMonitor {
  private readonly counters: NetworkDiagnostics = {
    requestsStarted: 0,
    requestsCompleted: 0,
    requestsAborted: 0,
    requestsFailed: 0,
    requestsActive: 0,
    bytesReceived: 0,
    bytesCompleted: 0,
  };

  get stats(): NetworkDiagnostics { return { ...this.counters }; }

  /**
   * Counts decoded response-body bytes actually delivered to this reader. HTTP content
   * encoding, HTTP/browser caches, headers, and retransmission are not wire-byte telemetry.
   */
  async fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    this.counters.requestsStarted++;
    this.counters.requestsActive++;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null = null;
    let cancelRead: (() => void) | undefined;
    let received = 0;
    let completed = false;
    const chunks: Uint8Array[] = [];
    try {
      const response = await fetch(url, { signal });
      body = response.body;
      signal.throwIfAborted();
      if (!response.ok) {
        // Do not consume an error document as an asset, or leave its stream unowned.
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
      }

      let result: ArrayBuffer;
      if (response.body) {
        reader = response.body.getReader();
        const activeReader = reader;
        // Native fetch normally aborts its body itself. Explicit cancellation also covers
        // fetch implementations whose returned stream does not wire the signal to reads.
        cancelRead = () => { void activeReader.cancel(signal.reason).catch(() => {}); };
        signal.addEventListener('abort', cancelRead, { once: true });
        if (signal.aborted) cancelRead();
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (value?.byteLength) {
            received += value.byteLength;
            this.counters.bytesReceived += value.byteLength;
            chunks.push(value);
          }
          signal.throwIfAborted();
          if (done) break;
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        result = bytes.buffer;
      } else {
        // A null body (e.g. an empty successful response) is still a completed request.
        result = await response.arrayBuffer();
        received = result.byteLength;
        this.counters.bytesReceived += received;
      }
      signal.throwIfAborted();
      this.counters.bytesCompleted += received;
      this.counters.requestsCompleted++;
      completed = true;
      return result;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        this.counters.requestsAborted++;
      } else {
        this.counters.requestsFailed++;
      }
      throw error;
    } finally {
      this.counters.requestsActive--;
      if (cancelRead) signal.removeEventListener('abort', cancelRead);
      if (reader) {
        if (!completed) void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (!completed) {
        // Covers cancellation while headers were pending, before a reader was acquired.
        void body?.cancel().catch(() => {});
      }
      chunks.length = 0;
    }
  }
}
