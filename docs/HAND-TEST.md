# Hand test

`npm run verify` runs every automated gate. This is the list it cannot cover:
anything that needs a real file, a real sidecar, a real peer, or a pair of eyes.

The e2e harness boots the frontend with **the Tauri IPC layer mocked**, so it
proves the shell renders and the wiring holds. It never runs whisper, ffmpeg,
yt-dlp or iroh, and it never opens a file. Everything below is therefore
unverified by CI *by construction*, not by oversight.

Ordered by risk: the top of each section is the thing most likely to be broken
and worst if it is.

---

## 1. Job cancellation — every start path changed

Job ids used to come from a round trip to Rust. They are now minted locally, so
the id exists before any await. Seventeen call sites changed.

- [ ] Start a transcription, press **Stop within the first second**. The run
      stops, and no transcript appears afterwards.
- [ ] Start a clip export, Stop immediately. Same.
- [ ] Start a batch transcription of 3+ files, Stop during the **first** file.
      The current file stops, the rest are marked skipped, and nothing keeps
      running in Activity Monitor.
- [ ] Download a web source, Stop mid-download.

**What a regression looks like:** the UI returns to idle but work continues, and
a result loads over a screen that said it was cancelled.

## 2. Local-file transcription — the WAV now crosses IPC differently

The prepared WAV used to travel as a JSON number array; it is now a raw body
staged to disk by a separate command, and four commands were changed to derive
that file's path from one helper.

- [ ] Transcribe a **local file** with WebCodecs extraction on (Settings ▸ Local
      playback). Transcript appears, text is correct, speaker names if enabled.
- [ ] Transcribe a **long** local file (>10 min). Watch for a frozen window
      during "Audio extracted…" — that freeze is what this change removed.
- [ ] Re-transcribe the same file (re-diarize / re-transcribe for caption
      timing). Both paths use the same staged-WAV helper.
- [ ] Transcribe a **web source**. Different command, same helper.

### 2b. Speaker models — the path that moved out of App.tsx

`useDiarizerPrepare` now owns this. The states and the button are the same;
what changed is where they live and how a failed start releases its job id.

- [ ] Settings ▸ Transcription ▸ **Download speaker models**. It reports
      running, then a "Speaker models ready" notification, and the Detect
      speakers hint switches to cached.
- [ ] Start it and **Cancel**. It returns to idle with NO error banner, and
      the button is immediately usable again.
- [ ] With it already cached, run it again. Nothing should get stuck on
      "running".
- [ ] Trigger a failure twice in a row if you can (unplug the network mid
      download, twice). The button must still work on the third press — a
      job-id leak there used to be possible and is what the new test pins.

## 3. Exports — every write is now atomic

- [ ] Export a clip. Check the file plays.
- [ ] Export a clip **over an existing file of the same name**, and confirm the
      result is complete, not truncated.
- [ ] Export a transcript (SRT / TXT), an AI summary, review notes, and the
      settings export. Each should land complete.
- [ ] Save a diagnostics report from Settings ▸ About.
- [ ] **Join a co-review session, then save a report immediately** - before
      doing anything else that would write a log line. The report must contain
      a Session block with your role and the roster. It used to record
      `role: off` and omit the block entirely, because the handler held session
      state from whenever the last log line landed.

### 3b. The queue button, which used to go dead in silence

A single export holds the shared local-export cancel token, so a queue has to
wait for it. Nothing said so: the queue branch replaces the single export's own
button, and a running export also suppresses the "No output folder set" nudge,
so the panel went quiet around a full-strength button reading `Export 3 clips`
that did nothing when clicked.

- [ ] Start a single clip export. **While it is still running**, add two or
      three clips to the queue.
- [ ] The primary button should now read **"Waiting for the current export"**,
      greyed, with a tooltip on hover saying the queue starts when the current
      one finishes. It must NOT read `Export 3 clips`.
- [ ] When the single export finishes, the button should return to
      `Export 3 clips` and work.
- [ ] Sanity check the other direction: with the queue running, the same button
      reads `Exporting…`, not the waiting text.

## 4. Co-review — reactions, and the STUN setting

- [ ] With a peer: react to a comment, **remove the reaction**, end the session,
      reopen the review. It must stay removed. Repeat after both sides rejoin.
- [ ] Settings ▸ General now has a **STUN server** field. Confirm the default is
      filled in and a session with camera/mic still connects.
- [ ] Empty the STUN field and start a session on the **same LAN**. It should
      still connect. (Across the internet it is expected NOT to.)

### 4a. Share a portion of a screen — the caption used to lie

Needs a real screen; the mock has no ScreenCaptureKit. Open a session, click
**Share**, choose the **Portion** tab, pick a display.

- [ ] Drag a **wide, short strip** across a title bar — roughly 400 wide by
      under 16 tall. The caption must read **"400×9 is too small to share."**
      and Share must stay disabled. Before this, it read "400×9 on Built-in
      Display" and Share was dead anyway, which sent you hunting for a fault
      that was in the drag all along.
- [ ] Drag a **tall, narrow strip** — the same must happen with the numbers
      the other way round.
- [ ] Click once on the thumbnail without dragging. It must say **"Drag the
      area to share."**, not scold you about a 0×0 selection.
- [ ] Drag a normal region. Caption reads `W×H on <display name>`, Share
      enables, and the shared picture matches the rectangle you drew.

### 4b. Modals now hold on to the keyboard

Nine dialogs changed. For each: open it, press **Tab** about fifteen times, then
**Shift+Tab** the same. Focus must stay inside the dialog the whole way round.
Then close it with **Escape** and press **Tab once** — focus must land back on
the control that opened it, not at the top of the app.

- [ ] Reader row menu (the ⋯ on a transcript row), Share ▸ Portion,
      the Connect YouTube sheet, "Who is speaking?", Manage speakers.
- [ ] While **Rename**, **Quick Look**, **Paste notes**, or the transcript
      **Search** modal is open, press **⌘F**. Nothing should happen. Before
      this, it yanked focus to the transcript search bar behind the dialog —
      you would be typing into a field you could not see.
- [ ] Manage speakers still autofocuses the filter box on open (the trap must
      not steal that), and closing it returns focus to where you were.

### 4c. Three modals had no backdrop at all

The most visible fix in a while, and the easiest to confirm. Each of these
should open **centred, over a dimmed and blurred page**, the way Settings does.
Before this they rendered in the bottom-left corner with about a third of the
box below the window edge, on no background.

- [ ] ⌘K ▸ "Search all transcripts…"
- [ ] Library ▸ right-click an item ▸ **Rename** (and a bulk rename)
- [ ] Library ▸ **Quick Look** an item. Its scrim is darker than the others
      on purpose; it should still cover the whole window.
- [ ] Compare against **Settings** and the **AI model info** modal, which were
      always correct, and confirm they still look the same.

### 4d. Stream chips brighten on hover again (needs a peer)

Only reachable in a live session with someone watching a stream, so this is
the least convenient item here and the one I could not verify myself.

- [ ] Hover the **"keep a copy"** chip over the video. The TEXT should
      brighten, not just the border. Tab to it and the same should happen.
      Its colour rule referenced a token that does not exist, so the
      declaration was dropped and only the border ever changed.
- [ ] The **quality chip** above it should read in the app's normal secondary
      text colour, matching other chips rather than inheriting from the video
      surface.

### 4e. Rename now asks before it touches the disk, once

- [ ] Library ▸ right-click a file ▸ **Rename**, change the name, press
      **Rename**. It must NOT write yet: a step appears saying it renames the
      file **on your Mac**, not just its name in the library, and that
      transcripts, review notes, posters and timecodes follow the new name.
- [ ] **Back** returns to the preview with nothing written. The preview list
      stays visible behind the question the whole time.
- [ ] Confirm WITHOUT ticking the box. Rename again: the warning should appear
      a second time. Confirming once must not opt you out silently.
- [ ] Now tick **Don't warn me again** and confirm. Every later rename, single
      or bulk, should go straight through with no warning.
- [ ] To get the warning back: clear `saucebunny.renameDiskAck` from
      localStorage (there is deliberately no Settings toggle yet - say if you
      want one).

## 5. Library

- [ ] Add a root whose media sits **four folders deep**. Home should now say
      some folders go deeper than it scans, rather than showing them empty.
- [ ] Search for a common word in a large library. If results are capped, the
      note names both folders and files.

## 6. Keyboard — several fixes, all invisible to a mouse

- [ ] Open Settings, press **Shift+Tab as the very first key**. Focus must stay
      in the dialog. (This escaped behind the scrim before.)
- [ ] Open Settings, Tab ~25 times. Focus never reaches the page behind.
- [ ] Escape closes it and focus returns to the gear.
- [ ] Same three checks for: Rename dialog, transcript search, library
      Quick Look.
- [ ] Open the **notifications** bell with Enter, then Tab. You should land
      inside the panel, not on the next toolbar button.
- [ ] In the transcript **history** popover, Tab to a row and press Enter — it
      opens. Tab to a row's × and press Enter — it removes that row and does
      **not** also open the transcript.

## 7. Scrub after a long idle — the one that needs a wait

The known bug: park on a frame, leave the app for a long while, come back and
scrub, and it holds on the parked frame before moving. WebKit tears the decode
pipeline down while a paused `<video>` sits idle and the rebuild is billed to
whatever gesture comes first. The app now pays it on return instead.

- [ ] Open a **local** file, pause on a frame, switch to another app for **20+
      minutes**, come back and scrub. It should move immediately.
- [ ] Same, but instead of switching apps, **minimise** the window (or fully
      cover it) for 20+ minutes. This is the case `focus` alone never caught.
- [ ] Check the Pipeline log, channel **seek**, after each. Expect
      `warmed the decoder on focus at <n>s` on return, and if the forensics
      line appears it should say the decoder was torn down while idle.
- [ ] Confirm the parked frame did **not** move: the warm-up is a zero-distance
      seek, so `currentTime` must be exactly where you left it.

**Still open, and now actually measurable:** the same idle problem on **web
sources** (`MSEStreamPlayer`) has diagnostics but no warm-up, because rebuilding
an MSE pipeline is a different and riskier fix than a zero-distance seek - three
causes look identical from outside and the remedies for them conflict.

Until today those diagnostics fired only on PLAY, which is not the gesture in
the report. A scrub never fires `play`, so a scrub-after-idle on a web source
recorded nothing at all. It now fires on the first seek too, which makes this
worth doing:

- [ ] Load a **YouTube (or other web) source**, let it buffer, pause it, leave
      for **20+ minutes**, come back and **scrub** (do not press play first).
- [ ] Read the Pipeline log, channel **seek**. The line begins `seek after
      <n>s idle` and ends with one of four verdicts. Which one it is decides
      the fix, so it is the thing worth reporting back:
      - `buffer survived` - the pipeline is fine and the stall is downstream.
      - `BUFFER EVICTED while idle` - WebKit dropped the SourceBuffer; the fix
        is a re-append, not a rebuild.
      - `buffer partly evicted` - same family, milder.
      - `NO BUFFER` with `pipeline gone` - ffmpeg or the fetch died on an idle
        timeout; the fix is keeping it warm or rebuilding sooner.
- [ ] Repeat with the window **minimised** rather than backgrounded. The local
      half needed both because `focus` alone missed the minimised case.

## 7a. Deleting a model now takes two clicks

These were the most expensive single clicks in the app: a Whisper or LLM
model is a multi-GB download, and the Delete button sat beside "Use as
default" in identical styling with its only explanation in a tooltip.

Do this on a model you are willing to re-download, or just arm it and let it
time out rather than confirming.

- [ ] Settings ▸ Transcription. Click **Delete** on a downloaded Whisper
      model **once**. Nothing should be deleted; the button should turn red
      and read **"Delete 2.9 GB?"** with the real size of that model.
- [ ] Wait about four seconds without touching it. It should go back to
      **Delete** on its own. (A confirm that stays hot is a mine.)
- [ ] Arm it again and press **Escape**. The arming cancels and **Settings
      stays open** - this is the bit worth checking, because the modal also
      closes on Escape and the two could easily fight.
- [ ] Press **Escape** again with nothing armed. Now Settings closes.
- [ ] Same two-click behaviour on an **AI Summary** model and on
      **Parakeet** (whose label reads "Delete the model?" - it has no size to
      name).
- [ ] Confirm one for real if you can spare the re-download, and check the
      model list refreshes and a model that was in use falls back to another.

## 7b. Escape closes the AI Summary's Export menu

It did not. The menu dismissed on a click away and ignored the key
entirely, while every other menu in the app closed. Thirty seconds to
check, and the same split has now appeared twice (the transcript history
was the first), so it is worth a look rather than a shrug.

- [ ] Generate a summary, click **Export**, press **Escape**. The menu
      closes and focus is not left somewhere odd.
- [ ] Open it again and click well outside it. Still closes.
- [ ] Open it and click the **Export** button itself. It toggles shut
      rather than closing-and-reopening — the deferred listener attach in
      `use-dismiss.ts` is what makes that work, and it is the part that
      breaks first if anyone "simplifies" the hook.

## 7c. AI Summary — llama-server now reports itself

Rust has emitted llama-server's stderr since the feature shipped; nothing was
listening, so model-load progress and start failures went nowhere.

- [ ] Open the AI Summary tab and generate a summary with a LOCAL model, with
      the Pipeline log open. Expect `llm` lines during the model load - the
      first run on a multi-GB model is the slow one worth watching.
- [ ] If a local model fails to start, the reason should now appear in the log
      instead of the tab simply never producing anything.

## 8. Screen reader — new landmark names, only VoiceOver can confirm them

Each view's main region is now named. The e2e run proves the name is in the
accessibility tree; only VoiceOver proves it is announced.

- [ ] Turn on VoiceOver (⌘F5). Press **VO+U**, choose Landmarks. Each view
      should list one main, named Library / Clip / Co-Review / Transcript, plus
      the Primary navigation. Nothing should say a bare "main".
- [ ] With VoiceOver still on, Tab through **Settings ▸ General** (STUN, TURN
      URL, username, password) and **▸ Captions** (size, font, background).
      Each should be announced by name. They used to announce as "edit text,
      blank" - the password fields included.
- [ ] **Settings ▸ AI APIs:** click the words "API key" and "Model". The
      caret should land in the field beside them. Those labels were previously
      decorative and clicking them did nothing.

## 9. Look — token changes, no computed value should have moved

- [ ] Timecodes, download percentages, cache sizes and the queue's numbers do
      not shimmy or shift width while they count.
- [ ] Nothing looks unstyled: 186 `border-radius` declarations were swapped to
      tokens with identical values, so any rounded corner that is now square is
      a real regression.
- [ ] The green room's step trail, "NO SOURCE LOADED", the URL hint and the
      Settings cache path are all readable — they were moved one step brighter.

---

## Known gaps, deliberately not fixed

- Command-palette secondary text is below WCAG AA (3.81–4.45:1). The token
  ladder clears the bar on the page background and not on raised surfaces;
  fixing it is a palette decision, recorded in `e2e/contrast.spec.ts`.
- 19 popovers still hand-roll their dismiss behaviour rather than using
  `useDismiss`; standardising them changes how Escape resolves when they nest.
- The library scan depth stays at 3 levels. Raising it trades scan time for
  reach on unknown disk layouts.
- ~~**Reduced motion covers animations but not transitions.**~~ Closed, and
  BOTH halves of the note that recorded it were wrong.

  It said all 58 keyframe animations were guarded. They were not: the e2e probe
  skipped any element whose `offsetParent` was null, which is true of every
  `position: fixed` element, so it never looked at the popovers, scrims,
  banners and modal backdrops where entrance animations mostly live. Fourteen
  were unguarded behind that blind spot - including the Settings backdrop
  fading in behind a dialog that was correctly holding still, and an INFINITE
  pulse on the live-session dot. All fourteen are guarded now, and
  `src/lib/reduced-motion-contract.test.ts` reads the stylesheets instead of
  the page, so no element can hide from it by not being rendered.

  It also proposed the wrong fix for the transitions: 33 suppressions or a
  tokenised `--lift`, both of which neutralise the transform. That breaks the
  app. `translateX(-50%)` on the playhead, the AI chip and the follow pill is
  CENTRING, not decoration, so removing it moves each one half its own width
  off target. What shipped instead is `transition-duration: 0s` on the 41
  affected rules - the travel goes, the destination cannot change, because a
  duration is incapable of moving anything.

  Worth a look by eye with System Settings ▸ Accessibility ▸ Display ▸ Reduce
  motion on: open Settings, the command palette, and a live session, and
  confirm things APPEAR rather than arrive, with nothing off-centre and no
  hover control that has stopped appearing.
