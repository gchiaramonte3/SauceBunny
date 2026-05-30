/**
 * One-shot rebrand migration: clippull.* → saucebunny.* localStorage keys.
 *
 * Called once at module load (before App renders). For every localStorage key
 * starting with `clippull.`, copy its value to the equivalent `saucebunny.` key
 * when that target doesn't yet exist. Old keys are left in place — users can
 * clean them up manually. This preserves transcript history + diarizer-ready
 * state across the Sauce Bunny rename.
 *
 * Pure side-effect on localStorage, no React state — lives here so App.tsx
 * isn't carrying boot-time plumbing.
 */
export function migrateLegacyStorageKeys(): void {
  try {
    const toCopy: Array<[string, string]> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("clippull.")) continue;
      const rest = key.slice("clippull.".length);
      const newKey = `saucebunny.${rest}`;
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(key);
        if (v !== null) toCopy.push([newKey, v]);
      }
    }
    for (const [k, v] of toCopy) {
      try { localStorage.setItem(k, v); } catch { /* quota — best-effort */ }
    }
  } catch {
    // localStorage unavailable (private mode quirks) — non-fatal.
  }
}
