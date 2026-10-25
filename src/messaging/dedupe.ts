/**
 * Both Sendblue and Photon deliver at-least-once. Remembers recent message
 * ids so a redelivery is processed only once. In-process only.
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
