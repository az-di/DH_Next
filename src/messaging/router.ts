import type { Messenger, Provider } from "./types.ts";

/**
 * Sends each message through the provider that owns its address, so several
 * networks can run side by side.
 */
export class RoutingMessenger implements Messenger {
  private providers: Pick<Provider, "network" | "messenger">[];

  constructor(providers: Pick<Provider, "network" | "messenger">[]) {
    this.providers = providers;
  }

  private pick(address: string): Messenger {
    const provider = this.providers.find((p) => address.startsWith(`${p.network}:`));
    if (!provider) throw new Error(`no messaging provider is running for ${address}`);
    return provider.messenger;
  }

  sendGroup(groupId: string, content: string) {
    return this.pick(groupId).sendGroup(groupId, content);
  }

  sendDirect(address: string, content: string) {
    return this.pick(address).sendDirect(address, content);
  }
}
