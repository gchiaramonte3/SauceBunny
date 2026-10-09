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

## 7d. String Outs and AAF Audio play after a long idle

The report (2026-10-08): after a long idle, Play in String Outs moved the
playhead and made no sound, with no error. This Mac's default output was
**Jump Desktop Audio**, a remote-desktop session's virtual device, which goes
and comes back with the session; the Web Audio output stayed "running" on the
device that had gone. Both players now make their output again before playing
after a minute of silence, after a device change, and when their clock stops
(`src/lib/audio-output.ts`).

- [ ] In String Outs, play a few seconds, pause, leave the app for **20+
      minutes** (long enough for the remote session to idle), come back and
      press Play. It should be audible at once, at the same volume.
- [ ] The same in AAF Audio, with a track's level changed first: the level
      should still apply after the idle.
- [ ] Pipeline log, channel **audio**: expect `String Outs: made the audio
      output again (N min without sound).` (or `AAF Audio: …`) just before
      it plays.
- [ ] While playing, switch the Mac's output device (or disconnect and
      reconnect the remote session). Playback should carry on audibly within
      a couple of seconds, with `the Mac's audio devices changed` or `its
      clock stopped while playing` in the log.
- [ ] Play, pause and play again within a minute: no line in the log (the
      output is kept while it is in use).

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

## 9. Look — token changes

**This section used to be headed "no computed value should have moved" and
that is no longer true.** It was written on 2026-08-15 against a commit whose
186 radius substitutions were all value-identical (verified exhaustively, by
pairing every removed and added line and substituting each token for its
value: 186 of 186, no exceptions). A week later a second commit finished the
scale ON PURPOSE and moved about 35 declarations by a pixel or two: 5px to 6,
7px to 8, 3px to 4, 11px to 12, 14px to 16. Its own message says so.

The checklist was never updated, so it told whoever read it that any
difference was a regression. That is worse than saying nothing: it sends
someone hunting for a bug in the ~35 corners that changed correctly.

- [ ] Timecodes, download percentages, cache sizes and the queue's numbers do
      not shimmy or shift width while they count.
- [ ] Nothing looks UNSTYLED. A corner that is now square is a real
      regression; a corner that is a pixel rounder than you remember is the
      scale being finished and is expected.
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

---

## This branch: reactions, caption diarization, and the session record

Five things that only a running app can settle. The first two are quick; the
session ones need two machines, or one machine and patience.

**1. A reaction lands on the picture.** Start a session, play something, send a
clap from the reaction picker. It should rise up the LEFT EDGE OF THE VIDEO and
fade, never appearing over the timecode field or the transport. Check it at a
small window too: the monitor box shrinks with the window, and the rise is a
fixed 300px, so what you are looking for is that the glyph fades out rather than
getting sliced off at the bottom of the frame. Turn captions on and send one
while a subtitle is up - they share the bottom of the frame and the emoji should
paint over the caption, not under it.

**2. Speakers on a YouTube caption file, without a re-transcribe.** Open a
YouTube video with auto-captions, let them load, and open the transcript's
Improve popover. It should offer "Add speaker labels" with the action button
reading **Detect speakers** (not Regenerate), and Tools should read **Detect
speakers** rather than "Re-detect speakers". Press it: the diarizer alone runs
against the cached audio and speaker labels merge into the captions you already
have. THE TEXT MUST NOT CHANGE - if the wording of the captions is different
afterwards, Whisper ran and the routing is wrong. On a transcript that already
has speakers, both should read "Re-detect speakers".

If it errors with "Source audio isn't cached", that is the honest fallback and
not this bug: the audio pre-cache had not finished. Wait and retry.

**3. A guest's session is remembered.** Two machines. Join as the guest, make a
note, end the session, and look in `~/Documents/Sauce Bunny/Screenings/`. There
should be a file on the GUEST's machine too - before this branch there was never
one. Its `participants` should name both people with real `joinedAt` times, and
`role` should be "guest".

**4. Quitting mid-session keeps the record.** Start a session, load a source,
wait a few seconds, then quit the app WITHOUT pressing End. The screening file
should already be on disk. (Before this branch it was written only when the
session ended cleanly, so this left nothing at all.)

**5. The shelf tells the truth about old records.** The lobby's "Past
screenings" list: sessions recorded before this branch have no roster, and their
rows must NOT say "0 people" - they should simply omit any mention of people
while still showing the time, the source count and the note count.

Worth noting while you are in there: the reaction rise and the screening
write-through are both timed, so if you are watching for either, give it a
couple of seconds before concluding it did not happen.

### Phase 4 additions

**6. Adopt a range the room agreed on.** In a session, post a review comment
with a RANGE (shift-I / shift-O arm it, then post) rather than a point. Its
chip row should now show **Mark** and **Queue** beside the timecode. Mark sets
your own in/out; Queue adds that span to your export queue. Check on the GUEST
too: adopting a range the host posted should set the guest's own marks and
change nothing on the host's screen. A point comment must show neither button.

**7. A guest who cannot open the source still gets a record.** The awkward one,
and the one worth the setup. Have the host load a source the guest cannot open
(a local file the guest does not have is easiest). The guest's screening file
should still list that segment, with `"watched": false` and the title of what
the room was on. Before this branch the guest's record said the room watched
nothing at all. Then have the host switch to something the guest CAN open: the
new segment should read `"watched": true`.

**8. Clear on quit actually clears now, and keeps what it must.** Turn on
Settings ▸ General ▸ Cache ▸ Clear on quit. Note the per-category sizes, quit,
relaunch, and look again: downloads/audio/meta should be gone. **Received
files must NOT be** - that is a peer's transfer and the only copy. Clearing
those is still possible, deliberately, via their own Clear button.

### Build 2026083101 additions

The marquee item is **review links**, and most of it needs a second machine.
What one machine can settle is listed first.

**1. A join code survives a relaunch.** The highest-value check here, because
it never worked before and the failure was invisible. Start a session, copy the
join code, quit the app entirely, relaunch, start a session again. **The code
must be the same string.** Before this the host minted a fresh identity on
every launch, so a code shared yesterday was undialable today and nothing said
so. Expect a **Keychain prompt** on the first run of a new build: the ACL names
the binary that created the item, so a rebuild asks again. Allow it. Dismissing
it is also a valid test: the app must still start a session, just without a
durable code.

**2. A link opens the app from cold.** Issue a link, quit the app completely,
then click the link. The app should launch AND land on the review, not launch
to an empty window. The running-app case is the easy half; the cold launch is
the one that needed a buffer, because the URL arrives before any webview
exists.

**3. Remove from Library is not Move to Trash.** Right-click an item ▸ Remove
from Library. It leaves the app; **the file must still be on disk in Finder.**
Check it in list view AND grid view, and in a sub-library, since the whole
complaint was that it worked in one place only.

**4. The library tree's chevrons.** Expand and collapse folders. This did
nothing at all before, so treat it as new rather than as a regression check.
Then quit and relaunch: the expanded set should come back the way you left it.
While you are there, confirm the same rows still select, still highlight, still
take a drop, and still open their right-click menu.

**5. Folder colours.** A folder given a colour in Finder should wear it in the
app, and the app's own right-click ▸ colour should stick, in the tree, the list
and the grid.

**6. Columns behave like Finder's.** Drag a column edge to resize, drag a
header to reorder, right-click the header to hide and show columns. Quit and
relaunch: the layout should be as you left it.

**Needs two machines:**

**7. The name on a note is the one the HOST typed.** Issue a link labelled
"Dana", have the guest join through it and set their own display name to
something else. Every note they post must be signed **Dana**. This is the point
of grants: a forwarded link cannot sign someone else's comments.

**8. Withdrawing a link disconnects them now, not later.** With the guest
connected and reading, revoke their link on the host. **They should drop
immediately.** Marking alone used to mean revocation took effect at their next
visit, so the person you had just removed kept reading. Any OTHER outstanding
link must keep working.

**9. Invite only.** Turn it on. A peer with the lobby join code but no link is
turned away. Turn it off: they get in again. Off is the default, deliberately.

**10. A note written while the link is down is kept.** With a session running,
put the guest's machine offline (turn off Wi-Fi is enough), post a note. It
must show as **waiting**, not vanish and not claim it sent. Bring the network
back: it should arrive on the host. Watch for the bad case, which is the note
disappearing from the guest's screen without ever reaching the host.

### Build 2026083102 additions

Four defects in the library, all reported from use. Every one is visible on
one machine in under a minute.

**1. Finder colours on folders.** The decisive one, because it was reported as
a regression twice and "fixed" twice without working. In the sidebar tree, a
folder tagged in Finder must wear that colour on its folder glyph. On this
machine `_Desktop` is Purple, `01_Novella` Blue, `02_Showtime Ventura Website`
Red, `03_Chiaramonte Media` Yellow, `04_Personal` Green, `06_Dan's Research`
Gray and `Organzie` Yellow, so the sidebar should read as a colour chart
rather than a column of identical grey folders. Then tag a folder in Finder
while the app is open and come back to the window: it re-reads on focus, so
the colour should appear without a rescan.

**What a regression looks like:** every folder plain. Note that this is also
exactly what an untagged library looks like, which is why it survived twice.
Confirm at least one folder really is tagged in Finder before concluding
anything.

**2. The column dividers are visible without hunting.** Switch the library to
list view and look at the header WITHOUT moving the pointer. You should see a
hairline between every pair of columns. Before this they were invisible until
the pointer happened to cross a 10px strip, so the only way to learn a column
could be resized was to find it by accident.

**3. Dragging a column header does not ask you to import a file.** Press on
the Size header and drag it left or right. What must NOT happen is the
full-window "drop a video, audio or SRT file" card appearing. The column
should lift, an insertion line should show where it will land, and the other
columns should part around it. Release outside the window too: nothing should
stay stuck mid-drag.

**Also check the gesture did not eat the click:** a plain click on a header
still sorts, because a drag only begins after 4px of movement.

**4. Resizing a column no longer squashes the filename away.** Drag the right
edge of Size or Modified outward, hard. The Name column shrinks, but it must
STOP at a readable width rather than collapsing to nothing; past that point
the list scrolls sideways and the header scrolls with its rows, staying in
register. Before this the Name track had a floor of zero, so pulling a column
on the right made the filenames on the left disappear.

**Known gap, deliberately not fixed here:** Name cannot be resized directly.
It is the flexible track and has no divider of its own, unlike Finder's.

### Build 2026083103 additions

**The Name column resizes.** It is the one Finder property the list view got
wrong, and it was wrong invisibly: Name was the flexible track with its width
written into a string literal, so there was no number to change and no divider
to grab. The only way to affect it was to widen some OTHER column and let Name
absorb the loss, which is why dragging Size felt like it resized the wrong
thing.

- [ ] In list view, hover the right edge of the **Name** header. There is a
      divider there now, like every other column has.
- [ ] Drag it. Name should follow the pointer with no jump on the first pixel.
      The jump is the specific thing to watch for: in its default state Name
      has no stored width, so a drag that started from a guess would snap the
      column before moving it.
- [ ] Drag it wide, past where the other columns fit. The list should scroll
      sideways, and the header should scroll WITH its rows rather than sliding
      out of register.
- [ ] **Double-click the divider.** Name goes back to sizing itself to the
      pane. Without this, setting a width would be a one-way door.
- [ ] Quit and relaunch. The width you set is still there. (This one had a
      real bug: the width was computed and never persisted, so it reset on
      every launch. Nothing on screen would have told you.)
- [ ] Focus the divider with Tab and press the arrow keys. Same widths as the
      mouse gives, and Backspace resets it.
- [ ] Check the **web** and **frames** shelves too. All three lists share one
      Name header now; before this each had its own copy, which is why none of
      them had a divider.

**What a regression looks like:** the column jumps to a narrow width the
instant you start dragging, or the width is forgotten on relaunch.

### Build 2026090101 additions

**1. Selection is finally visible.** It was `--bg-4` on a row and a 1px white
ring on a tile: one grey step on a list that already had a stripe, a hover
shade and a focus shade. Reported twice as "there is no highlight colour".

- [ ] Click a clip in list view. The row fills PURPLE, and the Kind, Size and
      Modified cells stay readable on it rather than going dim.
- [ ] Shift-click one further down. The whole range fills, so the region you
      picked is a block you can see at a glance.
- [ ] Hover a selected row. It stays selected. Before, hover and selection
      were four percent apart on the same grey scale.
- [ ] Check the grid: a selected tile wears a 2px purple ring, which survives
      a bright poster in a way the old white one did not.
- [ ] Check the web shelf and the frames shelf. They share the row and card
      classes, so they should look the same.
- [ ] The folder tree uses a SOFTER tint on purpose: it is a permanent "where
      you are", not a transient pick.

**2. Columns you invent, like an Avid bin.** In Media Composer a bin in Text
view is a database you shape. This is that, for the library.

- [ ] List view, right-click the column header, choose **New Column…**. Type
      a name (say "Scene") and press Enter. A new heading appears.
- [ ] Select a clip, then click its cell under your new column. A field opens
      over the cell. Type and press Enter. The value sticks to that clip.
- [ ] Do the same from the keyboard: right-click the clip and use
      **Edit Scene…**. The editor must be reachable without a mouse.
- [ ] Press Escape while editing: nothing is saved. Click away instead: it
      saves. That is what a bin cell does.
- [ ] Drag your column narrower, drag it to a different position, and hide it
      from the header menu. It behaves exactly like Kind or Size, because it
      is the same machinery.
- [ ] Rename the column. Everything you typed into it must still be there.
      (Values are keyed to the column's id, not its name, for this reason.)
- [ ] Quit and relaunch. Columns and values are both still there.
- [ ] Delete the column. The menu item says "and its contents" because it
      means it. Add a fresh column with the same name afterwards: it comes
      back EMPTY, not carrying the old values.

**What a regression looks like:** a new column shows a copy of the Modified
date (the cell dispatch used to fall through to the date cell for any key it
did not recognise), or folder rows misalign with clip rows by one column.

**Not built yet, so do not look for them:** saved column layouts (Avid's Bin
Views) and sifting/filtering on a column's values.

### Session sharing: near-instant assets (needs two machines)

Three changes, and the first two are visible on the HOST alone.

**1. The offer exists before anyone fails.** Start a session, load a local
file. The "Send them the file" button (or "Send a preview copy") must be there
IMMEDIATELY. Before this it did not render until the guest had tried, failed,
and reported back, and then a human had to notice it appear. That wait had no
upper bound and sat in front of everything else.

- [ ] Host: join a session, load a file, look at the source bar. Buttons are
      there with nobody blocked yet.
- [ ] When someone IS blocked, the offer becomes the loud primary button. That
      is the only thing "blocked" changes now.

**2. Send the preview copy, not the master.** For any source that needed prep
(ProRes, 10-bit, AV1, most camera masters), the app has already written a
compact h264 copy for its own playback.

- [ ] Load a ProRes or other non-native file and wait for prep to finish.
      TWO buttons appear: "Send a preview copy" and "Send the original".
- [ ] Send the preview. On the GUEST, the name must read "… (preview)".
      That label is the whole safety story: it is a transcode, and nobody
      should approve a grade from it thinking it is the master.
- [ ] If they keep the copy, the file ON THEIR DISK is named "(preview)" too.
- [ ] Send the original instead and confirm it is NOT labelled preview.
- [ ] Time both. The preview should land in a fraction of the time: transfers
      are paced at 24 MB/s, so a 40 GB master is about 28 minutes and a
      preview of it is minutes.

**3. Audio-only sources stream at all.** This never worked.

- [ ] Host: load a WAV or MP3 (an interview, a podcast) and offer it.
- [ ] Guest: playback should start on its own. Before this the gate required a
      VIDEO codec, so an audio file offered, landed, and then nothing happened
      - no player, no error, no explanation.

**What a regression looks like:** the offer button disappears until someone
reports a failure; a preview copy arrives without "(preview)" in its name; or
an audio file offers and the guest gets a title with no player.

**Not changed, deliberately:** the guest still clicks to accept, and the host
still clicks to offer. That consent step is in CLAUDE.md and none of this
removes it. What is gone is the requirement that somebody fail first.

**Prep only re-encodes what is actually broken.** The decode probe used to
collapse "video decodes" and "audio decodes" into one boolean, so a file with
good H.264 video and an audio track WebCodecs could not handle had every frame
re-encoded to fix the sound.

- [ ] Load an H.264 file whose audio the WebCodecs path cannot decode (AAC in
      an older WKWebView is the common one). The log should say
      "Video is fine; remuxing and re-encoding audio only (no video
      transcode)" and the wait should be seconds, not minutes.
- [ ] Load a ProRes or other non-native master. It must STILL do a full
      transcode: the native player has to be able to open the prep output, and
      a copied ProRes stream in an MP4 would play as a black canvas.
- [ ] In both cases the result must actually play, with sound.
- [ ] Turn the WebCodecs decoder OFF in Settings and load an ordinary
      h264/aac MP4. It still preps, which is expected, and the log still names
      the toggle as the cause.

**What a regression looks like:** a ProRes file finishes prep suspiciously
fast and then plays as a black canvas with correct timecode. That is a copied
video stream the native player cannot open, and it is the exact failure the
codec guard exists to prevent.

**Live view: show them what you are watching (needs two machines).** The
instant path. Sending a file is minutes; this is about a second.

- [ ] Host: in a session with a guest, load any source and press
      **Show them live now**. The guest should see your picture within a
      second or two, in the video tile, not the stage.
- [ ] The guest's tile must say it is a LIVE VIEW, not the file. This is a
      real-time encode that degrades to fit the link, so nobody should be
      judging a grade from it. If it ever presents as the source, that is the
      bug worth reporting first.
- [ ] Your microphone must keep working while it runs. Talk to them. The
      mediabunny path carries no audio, and a bad override would take your mic
      down with it, so the room going silent is the specific regression.
- [ ] Press it again. The live view stops and your camera comes back.
- [ ] While live, load a DIFFERENT source. The guest should see the new one,
      or the live view should stop cleanly. What must NOT happen is the guest
      staring at a frozen last frame of the old source, which looks like a
      working share of a stalled video.
- [ ] Try it before pressing play on a fresh source: you should get "Nothing
      to show live yet" rather than a black tile that never resolves.
- [ ] Start a screen share while the live view is running (and the reverse).
      They use the same mesh senders, so one should take over cleanly rather
      than both fighting for the tile.
- [ ] Works for a web source too, not only a local file.

**What a regression looks like:** the guest gets a black tile that never
fills; the room goes silent when the live view starts; or the live view is
presented as the file rather than as a live view.

### Session and panel layout: the bleeding UI (needs two machines for most of it)

Six reports in one sitting, five of them the same defect: a flex row where
every child can shrink and none is pinned.

**1. The session header is one control, not seven.** It carried a "cannot open
this" chip, a live button, a preview button, a send-original button, an error
chip, a hashing chip and a sending chip, all in the half of the header designed
to truncate. On a laptop they overlapped into "THEM THLEFILE".

- [ ] Host a session on a LAPTOP screen, load a file. There is ONE **Share**
      button. Nothing overlaps, the filename is readable, and "End session"
      is not near the edge.
- [ ] Its label carries the state: "Preparing…", "Sending 42%", "Showing
      live", "Shared". Hover it to see who cannot open the source.
- [ ] It turns into the loud primary button when somebody actually is stuck.
- [ ] Open it: three options, each with its cost. "About a second", "Much
      faster, a transcode", "Full quality, slowest".

**2. The live view lands on the STAGE.** It used to arrive in the guest's
people tile, a thumbnail beside a face, which is why it never solved anything.

- [ ] Host: press Share, choose "Show them live now".
- [ ] Guest: the picture fills the STAGE, not a tile, with a badge reading
      "Live view of <name>'s screen". That badge must always be visible: it is
      a real-time encode and nobody should grade from it.
- [ ] Host audio still comes through their tile once, not twice.
- [ ] Throw a reaction at it. The emoji lands ON the live view.

**3. A source you cannot open blanks the stage.** It used to leave the
PREVIOUS video playing under the notice.

- [ ] Host loads something the guest cannot open. The guest's stage goes
      BLANK behind the notice. What must never happen is a different video
      still playing under it.

**4. The review toolbar never becomes two rows.**

- [ ] Open the review panel and drag it as narrow as it goes. All / Open /
      Resolved is now ONE dropdown, and the row stays on a single line at
      every width.
- [ ] The counts are still visible in the dropdown labels.

**5. Resolved no longer paints over the timestamp.**

- [ ] Resolve a comment in a narrow panel. The badge sits beside "1m ago"
      rather than across it.

**What a regression looks like:** any two controls overlapping at laptop
width, a second row of icons in the review toolbar, or a live view with no
badge saying it is a live view.

**Columns line up, and New Column works.** Two faults, both found from a
screenshot.

- [ ] Library list, right-click a heading, **New Column…**, type a name, Enter.
      The column APPEARS in the header immediately. Before this the model only
      read its column set at mount, so a column added live never rendered.
- [ ] Delete that column from the same menu. It vanishes and nothing to its
      right shifts. Before, a deleted column left an invisible width track
      behind that shoved every later column sideways.
- [ ] **From the web** and **Frames** in list view: Site / Size / Fetched
      values sit directly under their headings. They sat ~40px to the left,
      because the rows reserved a right gutter for the forget button and the
      header did not.

**What a regression looks like:** a new column that never shows up, or any
column's values drifting left of its heading on either shelf.

---


---


---


---


---


---


---


---


---


---

### Design audit additions (the build after 2026090202)

Twenty-six wrong states from a design-system audit, all CSS, all visible.
The contracts prove the rules; only eyes prove the pixels.

1. **Library, list view, a folder with 4+ files.** Hover the SECOND row, then
   the fourth. Both must lighten; before, every even row stayed flat. Click
   the second row: violet fill, white text in every column. Shift-click down
   two rows: three violet rows.
2. **Web tab and Frames tab, list view.** Rows alternate a faint stripe with
   no hairline between them, exactly like the Library list. Select a web row:
   the duration and the have-a-copy mark inside the name are white, not grey.
3. **Library, grid view.** Click a card. A 2px violet ring on ALL FOUR sides
   of the card, not a line under the picture. Tab away and back: the ring
   gains a brighter outer ring while focused.
4. **List view, drag a file onto a folder row.** The row brightens with an
   inset outline while the file hovers it. Before: nothing.
5. **Transcripts.** Shift-click two transcripts. Violet, like the library,
   not the old grey step.
6. **Review panel.** A note with a timecode: the chip is green, the same
   green as the transcript's jump chip beside it.
7. **Finish any job (transcribe a short file).** The toast icon, the bell's
   notification row and the queue's Done chip are green; the queue's Running
   chip is white while it runs, so the two are not the same colour.
8. **Open a transcript file that cannot be read** (rename its .srt to
   garbage). The alert icon is red, not pink.
9. **Keyboard.** Cmd-3 into the drawer, Tab onto the SELECTED tab: a ring.
   Cmd-, then Tab onto the selected Settings section: a ring. Click into the
   URL field, Tab twice: the paste and history buttons each show a ring.
10. **Review panel, Versions popover open.** Escape closes it. Then: open the
    bell popover, press Cmd-, . The popover is gone; Settings is on top.
11. **Open the volume, speed, view and notification popovers in turn.** Same
    corner radius, same shadow. Open Settings, then the speaker dialog
    (Transcript > speakers): same shadow, same radius, same entrance speed.
12. **Queue drawer with 2+ items.** The up arrow on the first item and the
    down arrow on the last are dimmed with a not-allowed cursor and do not
    light on hover.
13. **Shortcut sheet (Cmd-/).** The group headings are readable grey, one
    step brighter than before.
14. **Anything red.** Error hints in Settings, the review composer's error,
    the source-URL error, the logs pill: one red, the light one.
15. **Empty drawer, all four tabs.** With no source loaded, click Queue,
    Review, AI Summary, Transcript in turn. The title is the same size,
    weight and grey on every tab; only the icon and the words change.
16. **Reader page (open a transcript from the Transcripts view).** The
    play/skip buttons look like the main transport's: press one and it
    dips; while playing, the Play button sits on the raised fill.
17. **Sidebar, with an in/out range set.** The Selection timecode is
    semibold mono; the SELECTION label above it matches the FILENAME label.
18. **Settings > Keyboard.** A shortcut with a description shows it in the
    normal secondary grey under its name, not a dimmer one-off grey.

36. **Discord link.** Settings ▸ About: a row with the Discord mark and
    "Join our Discord", under the update row. Clicking it opens
    discord.gg in your DEFAULT BROWSER and the app stays exactly where it
    was. If the app itself navigates, that is the bug this avoided.

37. **Frames, list view.** Right-click a row: a menu appears with Reveal in
    Finder, Move to folder, Remove from Library and Delete frame. Right-click
    a row that is NOT selected and it becomes the selection first; right-click
    one that is already part of a multi-selection and the selection is left
    intact. Shift+F10 opens the same menu from the keyboard. Then switch to
    grid view and confirm its menu still works as before.

38. **Tidy up.** Type, exactly: `sound desgin here is thin, fix in the mix`
    and press the wand. It must come back capitalised, spelled correctly and
    ending in a full stop. Then try a note with a timecode and a clip name
    (`at 01:23:04 the cut feels lae in a007_c012.mov`): the timecode and the
    clip name must be character-for-character identical afterwards, and the
    clip name must NOT be capitalised.
39. **It always says what it did.** Press the wand on an already-clean note
    ("The grade is too warm."). A bar must say "Already tidy. Nothing to
    change." It must never just stop with no message, which is the bug.
40. **Undo still works in one step** after any of the above.

41. **Library ▸ Review sessions.** A new section under Frames. It lists past
    sessions with who was there and how many notes were taken. Switch between
    list and grid, sort by clicking the list headings, search a person's name,
    lasso-select several. Double-click reveals the record in Finder. Hold a
    short session, end it, and confirm the new row appears WITHOUT relaunching.
42. **The lobby.** Review ▸ (not in a session). There should be no "Default
    camera · Default mic" strip and no Review links block. "Host a session"
    and "Join a session" are large headings, host first. Load a clip, then
    look at the session name field: it should be pre-filled as a placeholder
    with the clip name plus the date and time. Press Start without typing and
    confirm the session is called that.
43. **Camera off by default.** On a machine that has never used co-review,
    join or host: your tile starts with the camera off. In the green room,
    pressing "Enable camera and mic" must show your own preview.

44. **Scrub speed in a session.** Load a YouTube link in the clip panel and
    drag the playhead: note how quickly the picture follows. Start a session
    with the same link and do it again. The two should feel the same. Then
    watch a guest's screen while you drag: they should sit still on the frame
    they were on and jump ONCE, when you let go, rather than chasing you.

45. **Start a session twice.** Host one, then (without ending it) find any
    path back to the lobby and press Start again. You should be returned to
    the running session, NOT shown "A co-review session is already active".
    Then end the session and start a new one: that must work first time.
46. **Column lines.** Library ▸ any shelf ▸ list view. One continuous line per
    column boundary, from the header through the last row, lining up exactly
    with the draggable header divider. Drag a divider: the body line follows.
    Check the same in From the web, Frames and Review sessions.
47. **Right-click a row in From the web** (list view, not grid). A menu with
    Open, Reveal (only when a copy is downloaded), Forget and Delete the copy.
    Shift+F10 opens it too.
48. **Look at the empty stage on a large display** for gradient rings. There
    should be none.

49. **The session ledger.** Hold a co-review on a clip and leave a note or
    two; end it. Hold a SECOND session on the same clip, leave different
    notes, end it. Open that clip's review panel: above the notes there should
    be a control reading "All notes", and opening it lists both sessions,
    newest first, with dates, participants and per-session note counts.
    Choosing one shows only its notes and the control marks itself as scoped;
    choosing All notes brings everything back.
50. **The ledger must never hide a note by default.** Open a clip you reviewed
    ALONE: the control should not appear at all, and every note is visible.
    Then check a clip reviewed in one session only: the control appears, still
    defaulting to All notes.
51. **A guest's notes belong to the session too.** With a peer in the room,
    have THEM leave a note. After the session, that note must appear under
    that session in your ledger, not under "Outside a session".

52. **Record a session.** Host one, press the record dot in the room bar.
    A red frame appears around the picture and stays there while a source
    reloads or errors. Stop it: a toast names the size and says Movies, Sauce
    Bunny, Sessions. Open the file - it must play, have sound, and show the
    window at full size rather than 1600px wide.
53. **Quit mid-recording** (Cmd-Q while it runs). The file must still play up
    to the moment you quit, and must NOT be left named `.part`.
54. **A guest sees it.** With a guest connected, start recording: their copy
    shows the red frame too. Stop: it clears on both. Have the guest drop and
    rejoin while you record - their frame must come back, not stay dark.
55. **Refusal with a number.** If the volume has under 2 GB free, Record must
    refuse and say how much is free rather than failing silently.

56. **Scrub in a live session, on a web source.** Drag the playhead a long
    way (outside what is buffered). You must see a held frame throughout, then
    the new position - never a black rectangle. Do it on the FIRST scrub after
    loading, which is the case that always failed.
57. **Same, as a guest watching the host's file.** Same rule: held frame, then
    the new position.
58. **Leave a guest watching for a few minutes** so the quality can step up.
    They must stay where they are, not jump to 00:00.

### People tiles and the A/V mesh

31. **Your own tile.** In a session, look at your tile: camera and mic buttons
    in the LOWER RIGHT, "Presenting" in the UPPER RIGHT if you have the floor.
    There must be exactly ONE mic indicator. Click mute: the button changes and
    nothing else contradicts it. Unmute and mute a few times; no second glyph
    should ever appear disagreeing with the button.
32. **A peer's tile is clean.** No buttons over their face, no "Let them
    present" floating in the picture. Right-click the tile: a menu with hide
    their video, mute them (both marked "for me"), let them present, and
    remove from session. Arrow keys move through it, Escape closes it, and
    focus returns to where it was.
33. **Right-clicking your OWN tile does nothing.** There are no actions to
    take against yourself.
34. **A peer who never connects (needs two machines, or one on a hotspot).**
    If the mesh cannot establish, the tile must NOT sit on "Connecting"
    forever: within about 30 seconds it reads "No connection". Open the
    Pipeline panel and look for the ICE lines, including whether only
    local-network candidates were gathered. That line is the one that tells
    you a TURN server is needed rather than more patience.
35. **Camera and mic actually reach the other side.** Turn your camera off:
    the peer sees your avatar, not a frozen frame. Turn it back on: video
    returns without rejoining. Same for the mic.

### Live telestration (needs two machines for the sharing half)

19. **Solo first.** Start a session, open the review view. A pencil sits
    beside the screen-share button. Click it: the drawing palette appears over
    the picture (pen, highlighter, arrow, rectangle, ellipse, colours, size).
    Draw. The mark shows, holds about five seconds, then fades out smoothly
    rather than blinking off.
20. **It is not a note.** After drawing, look at the review panel: no new
    comment, no draft, nothing to post. Reload the app and the marks are gone.
    This is the whole feature; if a drawing ever appears as a comment from
    this pencil, that is the bug.
21. **Clear.** With marks on screen, a second button appears beside the
    pencil. Click it: everything clears at once.
22. **Fade setting.** Settings ▸ General ▸ Co-review calls ▸ "Live marks fade
    after". Set "Until I clear them" and draw: the mark stays indefinitely.
    Set 10 seconds and confirm it lasts noticeably longer than the default.
23. **Two machines.** Host draws; the guest sees the same mark on their
    picture within a moment, in the host's colour, and it fades on each
    machine independently. Then the guest draws and the host sees it. Clear on
    either side clears both.
24. **It does not steal the pointer.** With the pencil OFF, clicking the
    picture still works normally (play/pause, scrub). With it ON, the composer
    pencil and this one do not fight: turning one on does not leave the other
    capturing.

### Comment enhancement and spell-check

25. **Spell-check.** Type "recieve " in the comment box: it gets the red
    dotted underline. Same in the sidebar's Filename field and in transcript
    search. This never worked before in any of them - WebKit gates the
    underline on a user default nothing set, which is why the r43 screenshot
    showed "Thansky ou" unflagged. Confirm too that nothing you type is
    silently corrected.
    If you have ever turned spell check OFF from the right-click menu inside
    this app, it stays off by design; `defaults read com.saucebunny.desktop
    WebContinuousSpellCheckingEnabled` prints 0 in that case, and deleting the
    key restores the default.
26. **Enhance.** Write a rough note ("sound desgin here is thin, fix in the
    mix"). A wand sits between the range button and Post. Click it: the button
    sweeps violet into green while it works, then the note is replaced by a
    tidier version that says the SAME thing. It must not add an opinion, must
    not become a paragraph, and must keep any timecode or name verbatim.
27. **Undo.** Immediately after, press Cmd-Z, or click Undo in the bar that
    appears under the box. Your exact original text comes back in one step.
28. **Undo stops being offered once you edit.** Enhance, then type a word. The
    Undo offer disappears and Cmd-Z now behaves like normal text undo rather
    than wiping what you just typed.
29. **No model, no crash.** With the local provider selected and no model
    downloaded, the wand explains that in a dismissible bar rather than
    failing silently.
30. **It never posts.** Nothing above should create a comment until you press
    Post yourself.
19. **Library, list view: New Column, all the way through.** Right-click any
    heading, choose New Column, type "Take", press Enter. A Take heading
    appears with an empty cell on every row, lined up under it. Click a row
    to select it, then click its empty Take cell (the cursor turns to a text
    beam): an editor opens IN the cell. Type A1, Enter. Right-click the Take
    heading: Rename and Delete are there; deleting it takes the cells with
    it and nothing else shifts. Before this build the empty cell had no
    height at all, so there was nothing to click.
20. **Sort direction.** Click Size once: largest first, like Finder. Again:
    smallest first. Click Name: A to Z, and Size loses its caret.

## Two claims that only two machines can settle

The first was settled by finding it in the code and fixing it, so it is now a
regression check rather than an open question. The second is still true.

**1. Does a guest's note about a LOCAL FILE come back when they open it alone?**
*(Found, and fixed in build 2026083101. Verify it stays fixed.)*

This is the founding invariant of the whole session design, in its acid-test
form: *opening a source solo, with no screening file present, must still show
every note made about it in a session.* The concern was that during a session a
guest's notes were filed under the wire FINGERPRINT, while a later solo open of
the same file resolved to a local PATH key, leaving the notes on disk under a
key nothing looked for.

That is exactly what was happening. A guest now records which review key a file
arrived as (`rememberReceivedAs` / `receivedReviewKey` in `src/lib/review.ts`),
so the solo open resolves to the same document.

To verify: two machines, host shares a LOCAL file (not a web URL), guest
receives it and posts a comment. End the session. On the GUEST, open that same
file on its own and look at the review panel. The comment must be there. If it
is not, look in `~/Documents/Sauce Bunny/Reviews/` on the guest for a file
whose name is a fingerprint rather than a path slug - that is the symptom.

**2. The source-level verdict cannot be set by anyone.**

Not a hand test so much as a thing to see for yourself: open any source, look
for a way to mark it Approved or Needs changes, and note that there is none.
The chips render, the Markdown export has a line for it, the co-review protocol
relays it and Rust has anti-spoofing code naming it - and no user can reach any
of that. Every source reads Pending permanently, including in the Markdown a
client receives.

`review-writer-contract` now records this. Deleting its `setStatus` entry is
the acceptance test for whenever the verdict UI gets built.

### Assistants (Claude Code or Claude Desktop, read-only)

1. **Claude Code.** Settings ▸ AI APIs ▸ Use Sauce Bunny from Claude ▸ Copy
   the Claude Code command, paste it in a terminal, then start `claude` and
   run `/mcp`: sauce-bunny is connected with ten tools. Ask "What
   sequences do I have in Sauce Bunny?" and "Find where ISABELLA says she's
   tired in AFF BANK 1": the answers name timecodes that match AAF Audio,
   and cite `saucebunny://` line addresses. macOS may first ask to let the
   terminal see Documents.
2. **Claude Desktop.** Save extension…, open the `.mcpb`, Install. In a new
   chat, "Read the string out Sore Feet Complaint clip by clip": clips come
   back with record and source timecode and who speaks. Quit Sauce Bunny
   first: it still works (it reads the files).
3. **Nothing changes.** With Sauce Bunny open on a string out, ask Claude to
   change it: it says it can only read. History shows no new step.

### Preview ▸ Source ▸ Screen on macOS's picker (docs/PROGRAM-CAPTURE.md)

1. Review ▸ Preview gear ▸ Source ▸ Screen ▸ **Choose screen…**: macOS's own
   sharing picker appears (not a list of ours). Sauce Bunny's windows are not
   offered. No Screen Recording prompt and no "bypass the private window
   picker" alert appear, now or after a week.
2. Pick a display and press Share: the Preview shows it within a few seconds,
   labelled with the display's name. **Sauce Bunny's own windows must not
   appear in the picture** (no hall of mirrors). macOS's menu bar shows its
   screen-sharing indicator; its Stop sharing ends the preview cleanly.
3. Cancel the picker instead: nothing starts and nothing reads as an error.
4. Tick Include system audio, play something in another app: the first time,
   macOS asks once for "System Audio Recording" for Sauce Bunny. Allow it; the
   room hears the other app. Leave the Preview muted (its default) and check
   nothing echoes; then unmute it briefly and note whether Sauce Bunny's own
   playback is captured back (the open question in docs/PROGRAM-CAPTURE.md).
5. Stop the preview, preview again: no second pick is needed. Quit and
   relaunch: Screen says to choose again. After quitting, no
   `saucebunny-program-capture` process is left (`pgrep -fl program-capture`).
6. System Settings ▸ Privacy and Security ▸ Screen and System Audio Recording:
   Sauce Bunny is not listed under Screen Recording.
7. Window ▸ **Choose window…**: the same picker, for one window. Click a
   window (or a whole app, when a window will not pick on its own, such as a
   remote-desktop viewer filling another display): it previews at once with
   only that window, labelled "App · Window title". Include application audio
   is on: play sound in that app and in another; only that app is heard. Close
   the window: the preview stops with "the shared screen or window went away".
8. Region ▸ **Choose screen…**: pick a display; a still of it appears and
   nothing starts. Drag an area (or type Left/Top/Width/Height): "Captures W ×
   H of …" reads true, and Preview shows exactly that part. Refresh still takes
   a new one. The macOS screen-sharing indicator flashes briefly for the still.
9. With audio on, Audio from ▸ **Only the apps I choose**: tick one app (say
   Jump Desktop). In a session, have the other person talk: they must not hear
   themselves, and only the ticked app is heard. With "Every app except Sauce
   Bunny", Safari is silent too (it plays through the same macOS process).
10. Neither Source dialog nor Share your screen is wider than its content on an
   ultrawide display (2560 × 1080): about 640 and 720 points.

### October 5 quick fixes (docs/UI-CORRECTIONS-2026-10-05.md, items 1 to 8)

1. Quit with a sequence open in AAF Audio and a string out open in String
   Outs; relaunch. AAF Audio says "Open a sequence" (nothing loads, nothing is
   logged); String Outs shows its list with no tabs. Open one of each, switch
   pages and back: they stay open.
2. Transcripts: no project called "Multitrack" appears, in the list or under
   Move to folder…; with AAF Audio documents listed, the right pane says "Pick
   a transcript to read."
3. AAF Audio, after a Whisper run that leaves a "!": click it. A small panel
   says how many passages need timing review and why; Review N passages
   switches the Transcript panel to that person at those passages; Transcript
   info opens the run details. Escape closes it. A green check explains itself
   the same way; a track with no speech shows a grey (i), not a green check.
4. Open a sequence whose AAF is on an unmounted drive, with Waveforms on: one
   line says the AAF can't be read, the lanes stay quiet, the Pipeline logs
   one failure, not one per lane. Mount it and press Retry: waveforms draw.
   At Track size Small, a lane's "Waveform unavailable" and Retry sit on one
   line, Retry fully visible.
5. Pipeline ▸ Copy, then paste into a text editor: the diagnostics paste.
   Review ▸ Invite… (Invite reviewers): make a new link and press Copy link
   while no session is open: it pastes.
6. Export diagnostics during a co-review session: HEALTH says "Co-review
   session: hosting" (or joined); outside one, "none open".

### October 5: String Outs tools, Add sequence, dividers (items 9, 12, 13)

1. Open a string out at the narrowest window. The timeline's tool row is one
   line of tools: no Play, no RECORD or SOURCE timecode, no status text. The
   record pane has Go to start and Play beside its scrub bar and timecode, as
   the source pane does, and Space still plays. Lift a range: "Lifted …"
   appears as a quiet line under the string out's words.
2. Hide the source text, then switch the timeline to Source (the corner
   switch, or ⇧T): the source pane comes back, with its own Play.
3. Add sequence opens a menu under itself, to the left, about 420 pixels wide
   on the 2560-pixel screen, newest first: eight, then "Show N more". Hover a
   row and press ×, or arrow to one and press Delete: it leaves the list.
   Clear list empties it; "Show N hidden sequences" puts them back. Hide one,
   save that sequence again in AAF Audio: it is listed again. New string out ▸
   Start from leaves out what is hidden and offers to show it. Nothing is
   deleted from AAF Audio.
4. Drag the line between the source and the record: it moves, and the source
   text's scrollbar is not grabbed. Drag the line beside Ask and the one above
   the timeline. Tab to a divider: the arrows nudge it, Shift for bigger steps;
   Home and a double-click reset it. Relaunch: the sizes are kept. Narrow the
   window to its minimum: the record pane keeps its room, the source gives way.

### October 5: String Outs removed lines and playback (items 15 and 19)

1. Build a string out from three short chunks of a long sequence. With Removed
   lines on, only the cuts between the chunks show, struck through, one line
   per speaker; nothing from before the first chunk or after the last. Hover
   one: ↺ appears and restores it on every track. Right-click one: Restore
   this line.
2. Open a large string out (a whole sequence of many mics) and play it. The
   playhead line, the timecode and the highlighted word move smoothly; the
   window stays responsive (scroll the text and the timeline while it plays).
   Space pauses at once.
3. While playing, press I and O, M, ⌘B, and V from the source: each lands
   where the playhead is when you press it. Loop a marked range: it loops.

### October 5: AAF Audio's bleed pass and audio prep (items 10 and 16)

1. Open a transcribed multi-mic sequence with Pipeline open. Regenerate one
   track. When it lands, the Pipeline shows one "Bleed labels" row for the
   sequence, not two.
2. Rename a mic owner, then change the shoot date: no "Bleed labels" row
   either time. Right-click a line and choose "Bleed from another mic": one
   row, and the line dims. "Use the automatic call" undoes it the same way.
3. With Pipeline open, play a multi-mic sequence for ten seconds, Pause, and
   Play again: no new "Prepare" rows for the five seconds you were in. Scrub
   away and back: none for the window you came back to.
4. Go to Transcripts and back to AAF Audio, then reopen the same sequence
   from the menu: Play starts at once, with no "Prepare" rows.
5. Settings ▸ General ▸ Cache lists AAF Audio playback with a size. Clear it:
   the size goes to zero, Waveforms and the bleed labels are still there,
   and Play prepares the audio again.

### October 5: AAF Audio documents in Transcripts (item 17)

1. Open Transcripts with a transcribed AAF Audio sequence. It is listed under
   AAF Audio by its sequence's name, as AAF Audio's menu names it.
2. Right-click it: Rename…, Move to project…, Open in AAF Audio, Open in
   String Outs, Reveal AAF in Finder, Remove from Transcripts, reachable with
   the arrow keys. Rename it: the new name shows here, in AAF Audio's heading
   and menu, and in String Outs' Add sequence. Open the AAF in Media Composer
   (or look at the sequence): its name is unchanged. Rename it to nothing: the
   sequence's name comes back.
3. Drag it onto a project heading: it is listed inside the project, and
   AAF Audio says every transcript is in a project. Quit and reopen: it is
   still there. Drag it onto the AAF Audio heading: it comes back out. Move to
   project… does the same from the menu, and Create & move makes a project.
4. Click it: above the transcript, its file, tracks, people, shoot date and
   length, with Open in AAF Audio and Open in String Outs. Each opens it.
5. Remove from Transcripts: it leaves this page only. Settings ▸ General ▸
   Removed from the Library or Transcripts brings it back.
6. Select two transcripts with ⌘-click and drag them onto a project: the
   ghost says "2 transcripts" and both move.

### October 5: AAF Audio's Transcript panel (item 14)

1. Open a transcribed sequence at the narrowest window. Under the person tabs:
   the search field, one row of chips, then the first line of transcript. No
   sentence runs across the panel.
2. Press the sparkle at the end of the search field: it lights, the field
   asks you to describe what you want, and Return searches with the local
   model. While it runs, Stop sits beside the sparkle.
3. The Bleed chip says the state ("Bleed not measured", "Bleed · 2 dimmed").
   Click it: Hide bleed, one sentence, Measure mics (and Check voices when
   levels left words unsure). Escape closes it and returns to the chip.
4. With passages to review, "N to review" switches to All voices and scrolls
   to them. After a run, "2 of 3 tracks saved · 1 failed" opens Transcript
   info.
5. The footer is one row: format, Export {person}, and a chevron with Export
   selected, Entire transcript, Avid files by mic or person, and the shoot
   date (Plain text and PDF).

### October 5: models download in Settings (item 11)

1. Settings ▸ Transcription ▸ Parakeet lists Parakeet Ultra (Recommended) and
   Parakeet TDT 0.6B v3, each with its size. Download Ultra: the row shows a
   bar and Cancel; Cancel stops it with no error, and Download starts again.
   Let it finish: Installed. Delete asks once ("Delete ≈0.6 GB?") before it
   deletes.
2. With Ultra deleted, open AAF Audio and choose Parakeet ▸ Parakeet Ultra:
   the model menu says "(not downloaded)", one line under the controls says
   "Parakeet Ultra is not downloaded." with Download in Settings…, and there
   is no download button on the page. Download in Settings… opens Settings on
   Transcription. Install Ultra there and close Settings: the line is gone
   without relaunching.
3. A track's Regenerate… with a missing model says the same, and its Download
   in Settings… closes the dialog and opens Settings.

### The Pipeline on String Outs (what to send when it hangs)

1. In String Outs, press ⌘\: the Pipeline opens at the foot of the page with
   room to read, and ⌘\ closes it. It opens the same way on AAF Audio.
2. Open a large string out (dozens of mics). The log says when it started reading
   every mic's words and how long that took. Anything that took more than a
   second, waited, or failed has a row; fast calls do not.
3. Export diagnostics: the file has HEALTH (memory, main thread, running
   processes, volumes with NEXIS marked network), PAGE (the string out in
   counts and ids, no titles or words), IN FLIGHT NOW, CALLS SINCE LAUNCH
   (per command: calls, failures, average, longest) and the log. Read it for
   any transcript text, title or person's name: there must be none.
4. When String Outs hangs next: wait 15 seconds, then Force Quit if you must.
   Relaunch and open the Pipeline: rows written DURING the hang ("Still
   waiting on …", "The app's main thread has not answered for …", "String
   Outs has not answered for …") are there, and, if macOS allowed it, a
   "Recorded what every thread was doing" row with a hang file in the log
   folder. Export diagnostics and send that file.
5. Open a string out built from several multi-mic sequences, once with the
   Pipeline closed and once with it open. Both times "Read N words in …"
   says a few seconds, not half a minute, and WORKING stays lit through the
   read instead of flickering.

### Media on Avid NEXIS during the working day (the freeze past Force Quit)

The app used to read every chunk of a playing clip on its main thread, so a
NEXIS volume slowing down under daytime load froze the window, and a read the
volume never answered left it unkillable. Reads now happen off that thread.

1. With NEXIS mounted and busy (or while AAF Audio is transcribing or
   measuring mics from it), open a clip that lives on NEXIS and play it,
   scrub it, and open the Library on a NEXIS folder with posters.
2. While it plays, move the window, open Settings, switch views: the app
   answers immediately even when the picture stalls. A stall now shows as a
   clip that stops loading, never a spinning cursor over the whole window.
3. If a clip ever hangs, ⌘Q (or Force Quit) closes the app. It may take as
   long as the volume does to give up on that one read, but the window must
   not be frozen while it waits.

### Transcript accuracy (AAF Audio, needs a transcribed multi-mic AAF)

1. **Parakeet Ultra.** In AAF Audio, Engine Parakeet, Model "Parakeet Ultra
   (not downloaded)": Download Parakeet Ultra. Cancel mid-way stops it with no
   error; Download again finishes. Generate two mics: their words follow the
   speech to the frame when you click them in String Outs, and words the
   recognizer was unsure of are underlined.
2. **Measure mics.** With the mics transcribed, Measure mics (it reads the
   media once; Stop works). All voices then says how many lines heard on
   another mic are dimmed, "Heard on X's mic", and Hide bleed is OFF: every
   line is still there. Pick a line you know is someone else's leaning into
   a mic and check it is labelled; pick a line said by the mic's owner while
   a neighbour talks over them and check it is NOT labelled. Tick Hide
   bleed: All voices now says the lines are hidden, and Settings ▸
   Transcription ▸ Bleed shows the switch on. Quit and reopen: still on.
3. **Your call wins.** Right-click a dimmed line ▸ "Name, on their own mic":
   it shows normally everywhere; right-click ▸ "Use the automatic call" puts
   it back. Reopen the AAF: the call is still there.
4. **Check voices** on AFF BANK 1 (the run nothing automated has done end to
   end: its parts were measured, the in-app loop was not). The bar first
   says these mics hear each other almost equally. Check voices runs (one
   mic and ten minutes at a time; Stop works), says how many voices it
   checked, and (with Hide bleed on) All voices then hides more than the
   handful levels alone did. Listen to five newly hidden lines: each should be a copy of someone
   else's line. Any warnings make sense (two people who really sound alike;
   a mic you know was swapped). Settings ▸ Transcription ▸ Voiceprints
   shows the count; Delete all, confirmed, empties it.
5. **Spell cast names.** On a scene with unusual names, generate with the
   box off, then on: names are spelled as on the mics, and read the rest of
   the scene for any word wrongly turned into a name.
6. **String Outs and assistants.** With Hide bleed on: in String Outs'
   source pane, All voices reads each line once; cutting a line no longer
   warns about overtalk from its own bleed copies; Ask "where does X say Y"
   cites no bleed copy. Turn it off: All voices shows the copies again, and
   an assistant's search returns them (marked as heard on the owner's mic).
7. **Score a scene** (phase 0): `--eval-template` a scene of two mics,
   correct the CSV by listening, then `--eval`; the report has WER, names,
   timing and bleed numbers.

### Ask with tools (String Outs, needs a Claude or OpenAI key, or a Qwen model)

1. In a string out made from AFF BANK 1, set Ask's model to Claude. Ask
   "Find every line where @ISABELLA or @NATHANIEL says they're tired,
   exhausted or that something is hard". While it works, the status says it
   is looking things up; the answer cites lines including 19:52:32:13 and
   20:18:12:01, and clicking one opens it in the source on that person's tab.
2. Select a few words in the record text and ask "who says this, and where
   else do they talk about it?": the answer is about the selection, not the
   whole sequence.
3. Ask "make a string out of those": **Make new string out** appears and
   nothing changes until you press it. Ask a follow-up ("is that every
   time?"): it still knows which lines it meant.
4. Ask something broad and press **Stop** while it is still looking: it
   stops within a second and says it was stopped.
5. Repeat 1 with ChatGPT, then with a local Qwen model, then with a non-Qwen
   local model (it answers the old way, from lines in the prompt).
6. **Ultrafast** (costs about six times the usual rate, so keep the question
   small). Settings ▸ AI APIs ▸ ChatGPT: set the model to `gpt-6-astra`, turn
   Ultrafast on, press Test: it connects. Ask's model reads "ChatGPT ·
   gpt-6-astra · Ultrafast", and step 1 answers noticeably faster than with
   the switch off. In the OpenAI usage dashboard the requests show the
   Ultrafast tier. Set the model back to one without the tier (`gpt-4o`) and
   press Test: OpenAI's own error says why, and nothing is charged at the
   Ultrafast rate. Turn the switch off.

### String Outs (needs a transcribed AAF Audio sequence and Media Composer)

Nothing below can be checked by the browser suite: it needs real linked
media, WKWebView's audio, and Avid.

1. ⌘7 opens String Outs. A first visit shows the welcome; **New string out…**
   from a transcribed sequence with "Start with the whole sequence" on: the text shows every person, coloured by lane.
2. Press Space. Audio plays from the linked MXFs; delete a sentence and play
   across the cut: no click at the join (10 ms crossfade). Delete a line with
   someone talking over it: the prompt appears and nothing below moves until
   you choose **Cut for everyone**.
3. ⌘Z / ⇧⌘Z step through the History panel (⌘Y). Quit and reopen: the edit
   and its whole history come back, and `~/Documents/Sauce Bunny/Edits/`
   holds a readable JSON copy.
4. Mark In/Out (I/O), Lift (Z) leaves a gap, Extract (X) closes it. Remove
   dead space: the review lists spans, Remove takes them out.
5. **Export AAF** (**Keep picture groups**, now the default), import into
   Media Composer: the sequence relinks to the original master clips, V1 is
   the group clip and still switches angles (right-click V1 ▸ the group's
   angles, or the multicam keys), each A track plays one person's own mic,
   markers import from the `- Avid markers.txt` beside it, gaps are filler.
   Every angle of the group is there, cameras Avid conforms to the group's
   rate (47.952 and 59.94 behind Motion Control) included: HEAT 1's V1
   switches between all 75. Repeat with **Keep all groups** and **Clip that plays**. This is
   the Phase 0 question: record which ones Avid accepts.
6. **One per person** on a transcribed sequence: one edit per person,
   each bite with a marker naming them; export one and check it in Avid.
7. Quit with a string out open and relaunch: ⌘7 reopens it, with no welcome.
   Do the same in AAF Audio with a sequence open: it reopens that sequence.
8. Ask (left column): pick a local model, then Claude with a key added in
   Settings → AI APIs; AI Summary must keep its own choice. Ask "pull every
   line from @Rosa about the move": the answer cites lines (click one), and
   **Make new string out** creates one without changing the current one.
   Drag the prompt's top edge taller; quit and relaunch, and the
   conversation is still there.
9. Select one track (A1), mark In/Out over a line where A2 talks, press Z:
   A1's clip shows a gap, A2 is untouched. Press X instead: it asks first.
   Export and check the gap is filler on A1 in Media Composer.
10. **Waveforms on demand (needs the 99-mic AAF on NEXIS).** Open it in AAF
    Audio and watch Activity Monitor: no `ffmpeg` starts, and the Pipeline log
    shows no `decode-linked-audio` until **Waveforms** is pressed. Press it:
    two lanes say "Preparing waveform…", the rest "Waveform queued", and
    the log shows one `decode-linked-audio` per clip, not one per minute.
    Note the time per track against the ~115 s measured before. Press
    Play while it builds: audition should not stall the way it did (each
    5-second window took 1.5-2.3 s to prepare). Press Waveforms again: the
    build stops and the log says "Stopped", not anything about transcripts.
11. Open a string out of that sequence with no waveforms built: every
    person's words appear within seconds. Remove dead space is greyed out
    and its tooltip points at View ▸ Waveforms. Turn that on: lanes fill in
    one by one, and the tool enables once every mic is measured.
12. **Tabs.** Open two string outs: each gets a tab above the editor, and
    switching tabs switches the string out. Close one with its × and another
    by focusing the tab strip and pressing Delete: the neighbour to the right
    opens (or the left one at the end), and the string outs are still in the
    list. Quit and relaunch: the same tabs come back. Let Ask retitle one
    (build a string out, then **Replace this one**): its tab follows. Start
    an **Export AAF**, switch to another tab and back: the export finished
    (or is still showing Stop) and its result message appears.
13. **A group angle, end to end (needs HEAT 2 and Media Composer on the
    NEXIS).** New string out from HEAT 2 with the whole sequence off. The
    timeline shows 21 tracks, but the source pane has everyone's words,
    ALAYSHA's included (her mic is an angle in A1's group). In Ask, "make a
    string out of everything @ALAYSHA says about the fire" and **Make new
    string out**: it opens in a new tab, with ALAYSHA on A22 and a marker on
    each bite. Play: you hear her mic, not AIDAN's.
14. **Export AAF** from that tab with **Keep picture groups**, import it
    into Media Composer on the NEXIS seat: every track relinks with no
    offline media, A22 plays ALAYSHA, Match Frame on A22 opens her master
    clip (260/261/262-61-ALAYSHA-0731_01), V1 is the group and switches
    between every camera, the 59.94 one included (it was never slow motion:
    Avid conforms it to the group's rate), the record timecode starts at 01:00:00:00, and Markers ▸ Import
    of the `- Avid markers.txt` puts her markers on A22. Then **Clip that
    plays** (V1 is one camera, no switching) and **Keep all groups** (every
    A track is a group too). Record all three; they settle Phase 0.
15. In the source pane, select a line of someone who is not on a track and
    press Append: the message says they now have a track, they appear as a
    new A-number, and they play. The × on their header takes them off again
    (their words leave the cut text), and ⌘Z brings them back.
16. **Source and Record (AFF BANK 1, 20 mics).** Open it from AAF Audio with
    **Open in String Outs**. The source pane says "Reading each microphone's
    words… n of 20" until the words arrive, then opens on the first person's
    tab; the tabs are AAF Audio's (All voices, a tab per person, "N more").
    All voices reads by turn, each sentence whole. In the timeline corner
    choose **Source** (or ⇧T): the timeline shows the sequence, 20 mic rows
    with their own clips and the sequence's timecode, V1 above them; the tool
    row is unchanged, with its record-only tools greyed. Select a line in
    ISABELLA's tab: the same In to Out appears on the source ruler. Press V:
    it lands in the record. Press I, move, press O in the source pane and
    Append: the marked time goes in even with no words (room tone). Turn a
    mic's selector off and Append a stretch nobody selected words in: that
    person is filler in the new clip only, and the earlier clips still play
    them. On HEAT 2 the tracks with alternates have a disclosure; open it
    and the angles sit under their track behind a ↳, off by default.
17a. **Patching (Avid's record tracks).** A new string out from AFF BANK 1
    with the whole sequence off has no record tracks, only "A1 Patch
    someone…". Cut in a line of ISABELLA's from her tab with every other mic
    off: she lands on A1, nobody else gets a track. In a record header,
    choose NATHANIEL in the menu: he takes that track and ISABELLA moves
    down; ⌘Z puts it back. × takes someone off and the tracks close up.
    Nobody's colour or source tab moves while you do this. Export with Keep
    picture groups and import into Media Composer: the tracks are in the
    same top-down order, and a one-person bite is filler on the other
    tracks.
17b. **A second string out of the same group.** Export two string outs of
    HEAT 1 with Keep all groups. The message after each ends "If Media
    Composer reports a group clip conflict on import, choose No To All."
    (Clip that plays has no such line.) Import both into one bin. The
    second import asks about a group clip conflict: click No To All. Both
    sequences import, and a group in each still switches angles and plays.
    If Media Composer crashes, note what was selected in the open bins
    beforehand: the 2026-10-08 crash was in the bin's selected-items label.
17. **Ask by person.** "Find every line where @ISABELLA or @NATHANIEL says
    they're tired, exhausted or that something is hard, and build a string
    out" on Qwen3.8 27B. The status names whose transcripts it reads and how
    many lines. Expect it to find 19:58:57:12 (Isabella, "Yeah that's hard"),
    19:52:32:13 and 20:18:12:01 (Nathaniel). The build is titled after the
    two of them, and has two tracks: ISABELLA on A1 and NATHANIEL on A2 (or
    the other way, whoever speaks first), each bite on its own person's
    track. Click a cited line that is not in the string out: it opens
    selected in that person's tab in the source, and V cuts it in.
18. **Layout at 1100×700 and at a large window.** AAF Audio: TRT sits beside
    the timecode, an I/O box appears when In or Out is set, zoom is a
    slider, and the scroll wheel over an open gain fader moves it 1 dB a
    notch without scrolling the tracks. String Outs: Play leads the tool
    row, undo and redo sit side by side, and names in track headers are
    whole. In and Out are white with a grey span between them, drawn with
    the chevron mark, in Clip, AAF Audio, String Outs and the Transcripts
    player. The transport row names no one: who is talking is not in it.
19. **Cutting like an editing timeline (October 3 spec, phase 1).** In a
    string out with a few bites, click the timeline to park the playhead
    in the middle of the second bite, select a line in the source and
    press V: the line lands at the playhead, the bite splits around it,
    and the playhead parks after it, so V again builds the cut in order.
    With Snap on (N) a press inside a word lands in the gap before or
    after it. Set a record In with I and press V: the In wins over the
    playhead. Press B with a line selected: it replaces what follows the
    playhead and the running time does not change. A new string out made
    from a sequence starts empty.
20. **Marks, the Avid way (phase 2).** In String Outs on the record side,
    on the source side, and in AAF Audio: I and O mark, G clears both, D
    clears In, F clears Out, Q and W go to them. A closed range shows a ×
    at its Out end; clicking it clears both. Straight after opening String
    Outs (nothing clicked yet) I and O still work. Mark a range in AAF
    Audio and click **Open in String Outs**: the source opens with that
    range marked on its rail and over its words. J steps back a second, K
    stops, L plays.
21. **Which side is live, and what the menus do (phase 3).** Click in the
    source text: the source pane gets a lifted outline and the record's
    selection steps back; click the timeline and the record lights. With
    the timeline on Source, Z, X, M and T do nothing (their buttons are
    off too). View ▸ Audio ▸ Crossfade at cuts: 4 frames sounds softer at
    a cut than Off. Click a marker on the ruler: the Inspector shows its
    name, comment and colour; Delete on the marker removes it.
22. **Tabs in track order.** On a grouped sequence (HEAT 2 or "Sequence
    with a Group Clip") the person tabs read A1, A1's alternates, A2 and
    on, left to right, in AAF Audio and in String Outs' source pane, each
    tab starting with its track. "N more" lists the rest in that order.
23. **What a Keep picture groups import puts in the bin.** Import a string
    out exported with **Keep picture groups**. Note whether the bin
    receives only the sequence, or every master clip and group clip in the
    show as well (the file carries them all, as the AAF rules require;
    Media Composer decides what it lists). Report which.
24. **Strip Silence (Audio menu).** With waveforms on, select A1 only, mark
    In and Out over a stretch with pauses and choose Audio ▸ Strip
    Silence…: Threshold -40 dB, Minimum 500 ms, Pads 100/200 ms. The pauses
    go silent on A1 only (A2 still plays there), nothing moves, ⌘Z brings
    them back in one step, and an exported AAF shows filler there in Media
    Composer. With Keep transcribed words on, no word is silenced.

### October 6: String Outs record as Avid layers, Neo's trim and selection tools

Start from New string out with a sequence as Source (the record starts empty,
A1 to A4).

1. **Record tracks are layers.** Mark a few seconds of Cara's lav in Source
   (only her source track on), press V: one clip lands on A1 named CARA.
   Patch Stephanie's source track to A1 (the → A1 menu on her source
   header), mark and press B over part of Cara's clip: A1 shows Cara, then
   Stephanie, then Cara, and A2 is untouched. Export AAF: in Media Composer
   A1 plays Cara, Stephanie, Cara.
2. **The playhead and scale stay put.** Switch Source and Record: the lanes,
   ruler and playhead start at the same x in both and never sit over the
   headers. Cut in another clip: nothing rescales; Fit (⇧Z) is the only
   thing that does.
3. **Selection.** Click a clip: a white outline. ⇧-click adds another.
   Drag in empty track space: a grey box selects what it touches; draw it
   around one edit per track and rollers appear instead. Delete leaves
   filler; ⇧Delete closes the time on every track (and asks first when that
   would take another track's clip). `,` and `.` nudge a frame, ⇧ ten; ↑ ↓
   move the clip a track. Drag a clip: the move previews, snaps to edits and
   the playhead, and lands on release as one undo.
4. **Trim.** U seats a roll at the nearest edit on the selected tracks;
   clicking an edit does too, just left or right of it seats the A or B
   side. `,` `.` trim a frame, M and / ten, ⌥← ⌥→ as well. A roll moves the
   edit on that track only; one side ripples every track (⇧R or the Ripple
   button switches to overwrite). A trim past the source's media stops there
   and says so. Dragging a roller previews the trim live.
6. **It reads as an Avid timeline.** No orange marks on the ruler or down
   through the tracks; a cut is only the line between two clips on its own
   track; no V1 row. Export with the default (Keep all groups) a string out
   with Cara on A1 and Stephanie from another moment on A2 over the same
   time: in Media Composer V1 shows Cara's picture and V2 Stephanie's, both
   still switchable groups.
5. **Tools.** C is the blade: click a clip and it is cut there, on that
   track (and on tracks you chose by hand). N rolls, Y slips (drag the clip:
   its picture and sound move inside it), R slides (the clip moves, its
   neighbours give and take). ⇧A is back to Selection. ⌘B cuts the selected
   clips under the playhead, else the selected tracks.

### October 6, evening: the plan's first pass (String Outs and AAF Audio)

Needs Media Composer and a transcribed AAF Audio sequence; start String Outs
from an empty string out, never the user's own.

1. **The AAF has no hidden cuts.** Cut Cara onto A1 for ten seconds, then
   overwrite Stephanie onto A2 over the middle of it. Export: in Media
   Composer A1 is ONE clip across A2's two edits (no match-frame edits on
   A1). Blade A1 in the middle (C) and export again: that edit is there.
2. **Playback is level and seamless.** Play across A2's edit while A1 runs
   on: no bump on A1. Cut in a fifth and a tenth person: the level of the
   first does not drop.
3. **Nothing goes missing.** Cut Kara's other line onto A2 over a stretch
   where she plays on A1: it is refused, naming A1. Lift Harry on A1,
   overwrite Jane onto A1 there, then ⇧⌫ Harry's struck words: refused,
   naming Jane.
4. **Pointer.** Over a clip the pointer is a hand, on its last 14 px a trim
   cursor, between two clips a roll cursor. Drag a clip: a frame count
   follows the pointer; hold it at the right edge of the timeline and the
   view scrolls. ⌥-drag leaves a copy. Esc mid-drag puts everything back.
5. **Copy, paste, Match Frame, J K L.** Select two clips, ⌘C, park later,
   ⌘V: both land on their own tracks. ⌘C in the transcript text still copies
   words. ⇧F on a clip opens its source on that frame with an In there.
   L L L runs 1x, 2x, 4x; J slows and reverses; K stops.
6. **AAF Audio.** Play a 3-hour sequence: the window stays responsive and
   the transcript keeps the playing line in view. Zoom to 8x and play: the
   view turns the page. Pinch on the lanes zooms around the pointer; a
   sideways swipe pans; a click on the ruler parks there. ⇧-click a line
   marks it, ⌥-click solos its mic.
7. **A re-export keeps its words.** Export the same group sequence from
   Media Composer again with one scene trimmed and import it: the new
   document opens with transcripts on every mic whose media was heard
   before, the trimmed lines at their new place, and a gap where the trim
   brought in new material. Owner names come with them.

### October 7: Ask about a range (needs an OpenAI or Claude key)

1. **Model menus.** Settings ▸ AI APIs with a key saved: both menus list
   the provider's models, chat models first and newest first. Refresh lists
   them again. "Type a model id…" takes one by hand. Test still answers OK.
2. **A range question.** In String Outs on a group sequence, ask "every time
   CHASE and KENDALL talk to each other about X between 21:10:00:00 and
   21:40:00:00". The Pipeline shows `find_conversations` and `scan` (not
   pages of `read_transcript`). The answer cites lines that select in the
   text, and comes back in seconds rather than a minute.
3. **Stop.** Ask a whole-transcript topic and press Stop while it scans:
   it stops at once, and the provider's usage page shows the requests ended.
4. **AAF Audio.** With ChatGPT chosen, mark In and Out, pick a person's tab,
   turn on Search with AI and describe a topic: "N matching passages ·
   (scan model)", lines from that person inside the marks only. With Local
   chosen, it runs on the Mac as before.
5. **MCP.** In Claude Desktop with Sauce Bunny connected, `read_transcript`
   answers in rows ("L… 21:10:09:07-… CHASE (A3): …").
6. **Every camera in a group.** Open the PLANK CHALLENGE HEAT 1 AAF (or any
   group with more than 16 angles) in AAF Audio, already imported once. The
   relink that runs on open re-reads the picture: V1's block reads
   `M007C004_260731CD` with a badge of 75, not "Clip 16", and hovering it
   names twelve angles "and 63 more". The labels and transcripts you had are
   still there.
7. **Ask: copy, edit, run again.** Select words in an Ask answer and press
   ⌘C: the words paste, not clips. Hover a question: Copy, Edit and Run
   again. Edit puts it back in the box. A failed answer offers Try again,
   which replaces the failure rather than repeating it.
8. **Ask on a whole transcript with gpt-4o.** Ask a question that reads a
   person's whole day (the twins one). It answers instead of "maximum
   context length"; the Pipeline shows the step sent twice.
9. **Ultrafast.** Settings ▸ AI APIs ▸ ChatGPT with gpt-4o and Ultrafast on:
   the switch says gpt-4o does not offer it, and Test connection works.
   Choose gpt-6-astra: Test still works, faster.
10. **The redesigns.** String Outs with no tab open: a centred list filed
    under Today, Yesterday, Previous 7 days and the month; each row leads
    with its cut drawn to scale (one bar per bite, an empty one dashed), then
    the name, bites and sequence, how long it plays, and when it was edited.
    Up and Down walk every row across the groups; the search finds by
    sequence name and Escape clears it. Review, empty: "Nothing on screen
    yet", Open file… and Paste a link, then Screen, Window, Region and NDI
    under "Or share live"; it fits without scrolling down to the smallest
    window, and Paste a link opens a field that Escape or Back leaves.
    Settings ▸ AI APIs: Local, Claude and ChatGPT each show only their own
    settings.
11. **Ask with gpt-6.1-sol.** Settings ▸ AI APIs ▸ ChatGPT, model
    gpt-6.1-sol, Ultrafast off. Ask a question in String Outs: it answers
    instead of "Function tools with reasoning_effort are not supported".
12. **Every angle reaches Avid.** Export "Twins Rivalry Before The Fall"
    (HEAT 1) with **Keep all groups** and import it: on V1, the angle menu
    lists all 75 cameras, the 47.952 and 59.94 ones included, the angle
    that plays is the one String Outs showed, and switching to a 47.952
    camera lands on the same moment as the camera it replaces.
13. **Conversations stack.** Open "Twins Rivalry Before The Fall" and choose
    Audio ▸ Stack Conversations: the status line says 22 conversations, and
    the record now shows DONNY and GILIO clips stacked over each
    back-and-forth, with no filler inside one. Play an exchange: Gilio's
    reactions during Donny's lines come from Gilio's own mic, nobody's word is
    cut at a clip edge, and the markers still sit on each line. ⌘Z puts the
    old layout back. Then ask Ask for a string out of a two-person exchange
    and build it: the same shape, without the menu.
