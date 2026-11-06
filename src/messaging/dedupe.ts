import type { InboundHandler } from "./types.ts";

/**
 * Providers deliver at-least-once. Remembers recent message ids so a redelivery
 * is processed only once. In-process only.
 */
export function createDeduper(limit = 1000) {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return true;
  };
}

/** Wraps a handler so each message id is handled once. */
export function withDedupe(handler: InboundHandler): InboundHandler {
  const firstTime = createDeduper();
  return (msg) => (firstTime(msg.messageHandle) ? handler(msg) : Promise.resolve());
}
