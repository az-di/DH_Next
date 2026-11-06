import type { Messenger, Provider } from "./types.ts";

/**
 * Sends each message through the provider that owns its id, so several networks
 * can run side by side. Ids without a network prefix belong to iMessage.
 */
export class RoutingMessenger implements Messenger {
  private providers: Pick<Provider, "network" | "messenger">[];

  constructor(providers: Pick<Provider, "network" | "messenger">[]) {
    this.providers = providers;
  }

  private pick(id: string): Messenger {
    const provider =
      this.providers.find((p) => id.startsWith(`${p.network}:`)) ??
      this.providers.find((p) => p.network === "imessage");
    if (!provider) throw new Error(`no messaging provider is running for ${id}`);
    return provider.messenger;
  }

  sendGroup(groupId: string, content: string) {
    return this.pick(groupId).sendGroup(groupId, content);
  }

  sendDirect(number: string, content: string) {
    return this.pick(number).sendDirect(number, content);
  }
}
