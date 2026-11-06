import type { Messenger, Provider } from "./types.ts";

type Routable = Pick<Provider, "network" | "messenger" | "capabilities">;

/**
 * Sends each message through the provider that owns its address, so several
 * networks can run side by side.
 */
export class RoutingMessenger implements Messenger {
  private providers: Routable[];

  constructor(providers: Routable[]) {
    this.providers = providers;
  }

  private pick(address: string): Routable {
    const provider = this.providers.find((p) => address.startsWith(`${p.network}:`));
    if (!provider) throw new Error(`no messaging provider is running for ${address}`);
    return provider;
  }

  supportsReactions(address: string): boolean {
    return this.pick(address).capabilities.reactions;
  }

  sendGroup(groupId: string, content: string) {
    return this.pick(groupId).messenger.sendGroup(groupId, content);
  }

  sendDirect(address: string, content: string) {
    return this.pick(address).messenger.sendDirect(address, content);
  }
}
