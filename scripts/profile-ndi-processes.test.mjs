import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProcess, parseFootprint, summarize } from "./profile-ndi-processes.mjs";

test("keeps PID, start time, and full spaced application path as identity", () => {
  assert.deepEqual(parseProcess("14950 204800 15.3 Mon Sep  7 08:42:07 2026 /tmp/Sauce Bunny.app/Contents/MacOS/sauce-bunny"),
    { pid: 14950, rssMiB: 200, cpuPercent: 15.3, started: "Mon Sep 7 08:42:07 2026", command: "/tmp/Sauce Bunny.app/Contents/MacOS/sauce-bunny" });
  assert.throws(() => parseProcess("unavailable"));
});
test("does not mistake peak footprint for current footprint", () => {
  assert.equal(parseFootprint("Physical footprint:         183.2M\nPhysical footprint (peak): 193.4M\n"), 183.2);
  assert.equal(parseFootprint("Physical footprint: 1.2G\n"), 1228.8);
  assert.throws(() => parseFootprint("Physical footprint (peak): 193.4M"));
});
test("summarizes only the selected process after warm-up without claiming a pass", () => {
  const samples = [0, 300, 600].map((elapsedSeconds, i) => ({ elapsedSeconds,
    processes: [{ pid: 4, rssMiB: 100 + i, ...(i ? { physicalFootprintMiB: 50 + i } : {}) }, { pid: 5, rssMiB: 9000 }] }));
  const result = summarize(samples, 4);
  assert.equal(result.afterWarmup, 2); assert.equal(result.rss.firstMiB, 101); assert.equal(result.rss.lastMiB, 102);
  assert.equal(result.physicalFootprint.endpointMiBPerMinute, 0.2);
  assert.deepEqual(summarize(samples, 9), { pid: 9, afterWarmup: 0 });
});
