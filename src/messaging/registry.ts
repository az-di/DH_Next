import { consoleProvider } from "./providers/console/index.ts";
import { discordProvider } from "./providers/discord/index.ts";
import { photonProvider } from "./providers/photon/index.ts";
import { sendblueProvider } from "./providers/sendblue/index.ts";
import type { Provider, ProviderDefinition } from "./types.ts";

/** Every available provider. Order sets the auto-selection preference within a network. */
export const PROVIDERS: ProviderDefinition[] = [photonProvider, sendblueProvider, discordProvider, consoleProvider];

/**
 * Picks what to run. An explicit list runs exactly those providers. A blank list
 * runs every provider with credentials, at most one per network, and falls back
 * to log-only when there are none.
 */
export function selectProviders(requested: string[], available = PROVIDERS): ProviderDefinition[] {
  if (requested.length === 0) {
    const selected: ProviderDefinition[] = [];
    for (const def of available) {
      if (def.isConfigured() && !selected.some((s) => s.network === def.network)) selected.push(def);
    }
    return selected.length > 0 ? selected : available.filter((def) => def.name === "console");
  }

  const selected = requested.map((name) => {
    const def = available.find((d) => d.name === name);
    if (!def) {
      const known = [...available.map((d) => d.name), "mock"].join(", ");
      throw new Error(`Unknown messaging provider "${name}". Available: ${known}`);
    }
    return def;
  });
  for (const def of selected) {
    const clash = selected.find((s) => s !== def && s.network === def.network);
    if (clash) throw new Error(`${def.name} and ${clash.name} both serve ${def.network}; pick one`);
  }
  return selected;
}

export async function createProviders(requested: string[]): Promise<Provider[]> {
  const providers: Provider[] = [];
  for (const def of selectProviders(requested)) {
    try {
      providers.push(await def.create());
    } catch (err) {
      throw new Error(`[${def.name}] ${(err as Error).message}`, { cause: err });
    }
  }
  return providers;
}
