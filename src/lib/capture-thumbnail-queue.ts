const MAX_ACTIVE_THUMBNAILS = 2;
let active = 0;
const pending: { start: () => void; cancel: () => void }[] = [];

function drain() {
  while (active < MAX_ACTIVE_THUMBNAILS && pending.length) pending.shift()?.start();
}

/** Both picker types share admission. An obsolete invoke still owns its native
 * slot until it settles; cancelling its UI must not admit another screenshot
 * early. Queued obsolete pages are removed without ever reading their pixels. */
export function requestCaptureThumbnail<T>(signal: AbortSignal, capture: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const job = {
      start: () => {
        signal.removeEventListener("abort", job.cancel);
        active++;
        void (async () => {
          try { resolve(await capture()); }
          catch (cause) { reject(cause); }
          finally { active--; drain(); }
        })();
      },
      cancel: () => {
        const index = pending.indexOf(job);
        if (index >= 0) pending.splice(index, 1);
        signal.removeEventListener("abort", job.cancel);
        reject(new DOMException("Aborted", "AbortError"));
      },
    };
    signal.addEventListener("abort", job.cancel, { once: true });
    pending.push(job);
    drain();
  });
}
