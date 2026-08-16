/**
 * The ICE server list for the co-review webcam/mic mesh.
 *
 * WHAT LEAVES THE MACHINE, and why this is a setting rather than a constant:
 *
 * A STUN server's whole job is to tell you how your NAT sees you, which means
 * it necessarily learns your public IP. For most WebRTC apps that is
 * unremarkable. For this one it is the single piece of the product that
 * contacts a third party without the user asking, in an app whose first
 * promise is that it runs on your machine - and it was hardcoded to Google,
 * so nobody could see it, point it elsewhere, or turn it off.
 *
 * Making it configurable does not make the contact disappear; a peer behind
 * NAT genuinely cannot be reached without either a reflexive candidate or a
 * TURN relay. What it changes is that the user can now aim it at their own
 * server, or empty it and accept LAN-only (plus TURN, if they run one). The
 * default is unchanged, so no existing session behaves differently.
 *
 * Note this is only the A/V mesh. Everything else in a session - control
 * traffic, the review doc, file transfer - rides iroh, which does its own NAT
 * traversal and never touches this list.
 */

/** Where the mesh has always pointed. Kept as the default so upgrading changes
 *  nothing; it is now visible in Settings and can be replaced or cleared. */
export const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

export type TurnConfig = { url: string; username: string; password: string };

/**
 * Build the `iceServers` array for an RTCPeerConnection.
 *
 * Both entries are optional and independent: a blank STUN url omits it
 * entirely (host candidates only, which works on a LAN), and a blank TURN url
 * omits that. Blank-but-not-absent matters - a user who deliberately clears
 * the field must not have the default handed back to them, which is why the
 * caller reads the stored value with `??` and not `||`.
 */
export function buildIceServers(
  stunUrl: string | null | undefined,
  turn?: TurnConfig | null,
): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  const stun = (stunUrl ?? "").trim();
  if (stun) out.push({ urls: stun });
  const turnUrl = (turn?.url ?? "").trim();
  if (turnUrl) {
    out.push({
      urls: turnUrl,
      username: turn?.username || undefined,
      credential: turn?.password || undefined,
    });
  }
  return out;
}

/** True when nothing external will be contacted to find a route - the
 *  strictest setting, and the only one that is genuinely local-only. */
export function isLanOnly(stunUrl: string | null | undefined, turn?: TurnConfig | null): boolean {
  return buildIceServers(stunUrl, turn).length === 0;
}
