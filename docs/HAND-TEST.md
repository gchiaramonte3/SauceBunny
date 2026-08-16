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

## 4. Co-review — reactions, and the STUN setting

- [ ] With a peer: react to a comment, **remove the reaction**, end the session,
      reopen the review. It must stay removed. Repeat after both sides rejoin.
- [ ] Settings ▸ General now has a **STUN server** field. Confirm the default is
      filled in and a session with camera/mic still connects.
- [ ] Empty the STUN field and start a session on the **same LAN**. It should
      still connect. (Across the internet it is expected NOT to.)

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

**Still open:** the same idle problem on **web sources** (`MSEStreamPlayer`) has
diagnostics but no warm-up - rebuilding an MSE pipeline is a different and
riskier fix than a zero-distance seek.

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
- **Reduced motion covers animations but not transitions.** All 58 keyframe
  animations stop under `prefers-reduced-motion: reduce`, and `e2e/reduced-
  motion.spec.ts` now holds that. 33 rules across 10 files still transition a
  `transform` on hover or active - almost all of them a 1px lift. Closing that
  is either 33 targeted suppressions or one tokenised `--lift` that a single
  rule can switch off; the second is the better design-system answer and the
  bigger diff. Both are a call to make deliberately, so neither was made here.
