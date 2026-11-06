// An address identifies a person or group chat across every network:
//   imessage:+15551234567   discord:user:123   discord:channel:456
// The prefix is how the router finds the provider that owns it. Beyond that the
// planning core treats addresses as opaque, and only providers look inside them.

/** Prefixes and unprefixes ids for one network. A blank id stays blank, meaning "unknown". */
export function addressing(network: string) {
  const prefix = `${network}:`;
  return {
    wrap: (id: string) => (id ? prefix + id : ""),
    unwrap: (address: string) => (address.startsWith(prefix) ? address.slice(prefix.length) : address),
  };
}

export const imessageAddress = addressing("imessage");

/** The network-specific part of an address, e.g. the phone number in imessage:+1555…. */
export function localPart(address: string): string {
  return address.slice(address.indexOf(":") + 1);
}
