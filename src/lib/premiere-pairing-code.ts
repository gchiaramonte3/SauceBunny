import type { PremierePairing } from "../bindings/PremierePairing";

/** Clipboard-only envelope. Never persist, log, or put this credential in a URL. */
export function formatPremierePairingCode(pairing: PremierePairing): string {
  const match = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/premiere$/.exec(pairing.url);
  if (!match) throw new Error("The local pairing address is invalid. Create a new pairing in Settings.");
  const code = `SBP1:${match[1]}:${pairing.expiresAt}:${pairing.token}`;
  parsePremierePairingCode(code);
  return code;
}

export function parsePremierePairingCode(value: string, now = Date.now()): PremierePairing {
  const match = /^SBP1:([1-9][0-9]{0,4}):([0-9]{1,16}):([a-f0-9]{64})$/.exec(value.trim());
  if (!match || Number(match[1]) > 65535 || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error("Copy the complete pairing code from Sauce Bunny Settings → Integrations.");
  }
  const expiresAt = Number(match[2]);
  if (expiresAt <= now) throw new Error("This pairing code expired. Create and copy a new code in Sauce Bunny Settings.");
  return { url: `ws://127.0.0.1:${match[1]}/premiere`, token: match[3], expiresAt };
}
