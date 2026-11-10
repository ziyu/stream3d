/** Preserve AbortSignal.reason, including non-Error values, like native fetch. */
export function abortReason(signal?: AbortSignal, message = 'The operation was aborted'): unknown {
  return signal?.aborted ? signal.reason : new DOMException(message, 'AbortError');
}

/** A caller may deliberately discard a cancelled request; awaiting still rejects. */
export function observeRejection<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}
