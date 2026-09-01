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

---


---


---


---


---


---


---


---


---

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
