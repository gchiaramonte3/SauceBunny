import { expect, test } from "@playwright/test";

test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium" });

test.beforeEach(async ({ page }) => {
  await page.route("**/scene-storage-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/scene-storage-test");
});

test("identical concurrent evidence saves are idempotent and survive reopening", async ({ page }) => {
  const saved = await page.evaluate(async () => {
    const url = "/src/lib/scene-analysis/evidence.ts";
    const { saveSceneEvidence }: typeof import("../src/lib/scene-analysis/evidence") = await import(url);
    // A storage-only fixture: detector correctness is covered by the real-worker suite.
    const evidence = { id: "fixture-id", schemaVersion: "sauce.scene-evidence.v1",
      proxy: { time_map_version: "relative-pts-us-v1", proxy_version: "h264-vt-540p-display-frames-v2",
        time_map: [{ analysis_start_us: 0, analysis_end_us: 1000, source_start_us: 0, source_end_us: 1000 }] },
      shots: [{ id: 1, transcript: "Original supplied speech" }] } as unknown as import("../src/lib/scene-analysis/evidence").SceneEvidence;
    await Promise.all([saveSceneEvidence(evidence), saveSceneEvidence(structuredClone(evidence))]);
    let conflict = "";
    try { await saveSceneEvidence({ ...evidence, shots: [] }); }
    catch (cause) { conflict = String(cause); }
    return { evidence, conflict };
  });
  expect(saved.conflict).toContain("Conflicting shot evidence");
  await page.reload();
  const records = await page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open("sauce-scene-evidence", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("detections").objectStore("detections").getAll();
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }));
  expect(records).toEqual([saved.evidence]);
});

test("a newer evidence database is not downgraded or overwritten", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("sauce-scene-evidence", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("future-data");
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const url = "/src/lib/scene-analysis/evidence.ts";
    const { saveSceneEvidence }: typeof import("../src/lib/scene-analysis/evidence") = await import(url);
    try {
      await saveSceneEvidence({ id: "new" } as import("../src/lib/scene-analysis/evidence").SceneEvidence);
      return "unexpected success";
    } catch (cause) { return (cause as DOMException).name; }
  });
  expect(result).toBe("VersionError");
});
