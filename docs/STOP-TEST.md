# Stop / Cancel — what to check

Build ID should read `2026-08-26-r166-stop-actually-stops`
(Settings ▸ About). If it says `r165`, the app is stale.

## A. Export queue (the one you hit)

1. Queue 4+ local clips, each long enough to take a few seconds.
2. Press **Export all**.
3. Hit **Stop** while item 2 is running.
   - Expect: the run ends. Items 3 and 4 stay **queued**, not done, not failed.
   - Expect: the toast says "Queue stopped", with counts.
   - BEFORE: the queue carried on through 3 and 4.
4. Repeat, but hit Stop in the pause **between** two items (right as a row
   flips to done).
   - Expect: same. Nothing after it starts.
   - BEFORE: Stop did nothing at all, not even a log line, and the run
     continued. This is the one that felt random.
5. Press **Export all** again.
   - Expect: it runs. (The stop flag has to be cleared or Export would only
     ever do one item again.)

## B. Single export, stopped late

1. Mark a long range on a big local file and Export.
2. Let the progress bar reach 100%, then hit **Stop** immediately.
   - Expect: "Export cancelled", and **no file** in the output folder.
   - BEFORE: the file was written anyway, Recents gained a row, and a
     success toast appeared for the export you just cancelled.

## C. AI, cold start (the big one)

Quit the app first so no model is resident.

1. Open a transcript, go to the AI Summary tab, ask anything.
2. While it says **"Loading <model> into memory…"**, look for **Stop**.
   - Expect: a Stop button is there.
   - BEFORE: no Stop at all. A disabled Send, and no way out.
3. Press it.
   - Expect: back to idle at once, and Activity Monitor shows `llama-server`
     go away rather than keep climbing.
   - BEFORE: nothing to press; the model finished loading regardless.

## D. AI chapters, cold start

Quit the app again first.

1. AI Summary tab ▸ **Detect chapters**.
2. Press **Stop** during "Detecting…" while the model is still loading.
   - Expect: it stops. No chapters appear afterwards.
   - BEFORE: the button was there and enabled and did literally nothing;
     the run loaded the model and generated the full list anyway.

## E. Reader analysis, cold start

Same shape: Analysis tab ▸ generate, Stop during "Loading the model…".
   - Expect: idle, no error message painted (a stop is not a failure).

## F. Nothing regressed

- Let a queue run to completion: "Queue complete", every row done.
- Let an AI answer finish normally.
- Stop a transcription mid-run (this path was already correct, so it is
  here only to confirm I did not break it).
