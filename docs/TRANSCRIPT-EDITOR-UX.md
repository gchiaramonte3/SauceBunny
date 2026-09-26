# Transcript Editor: UX spec and prototype

A new workspace where an editor cuts a scene by editing its transcript. Deleting
words removes that time from every speaker's track, the timeline closes up, and
the result goes back to Avid as a sequence that relinks to the same mic media.

This document is the design to approve **before** Phase 1 is built. It pairs
with a clickable prototype and with the research in
[AAF-ASSEMBLY-RESEARCH.md](AAF-ASSEMBLY-RESEARCH.md), which covers the AAF
round trip and the AI side.

## Try the prototype

```bash
npm run design:catalog
```

Then follow **Transcript Editor prototype ↗** in the catalog sidebar, or open
`/design-system.html?prototype=transcript-editor`. It is catalog-only: nothing
in it reaches the production build (`scripts/verify-design-catalog-build.mjs`
checks that).

**What is real:** the edit model. Every delete, speaker-only removal, move,
splice, restore, undo and redo changes the timeline exactly as it would in
Phase 1, and the text and the tracks are drawn from the same data.

**What is not:**
- The scene is generated, not recorded: an invented five-person kitchen scene
  with computed word timings, drawn waveforms and some crosstalk.
- Play moves the playhead on a clock and makes no sound.
- Nothing is saved, and Export is disabled.
- The sidebar's other sequences are placeholders.

### Things to try

1. Click a word, Shift-click another, press **Delete** (⌫). The words go, and
   every lane gains a clip boundary at the same place. A **¦** mark stays in
   the text where the cut is.
2. Turn on **Show removed**. The cut's words come back struck through, in
   place. Click the **¦** and choose **Restore what was cut**.
3. Select Wes's "the grill." and press Delete. Tamsin talks over it, so
   you are asked: cut the time for everyone, or silence only Wes's words.
4. **Shift-Delete** silences words on their speaker's track only. Nothing
   moves; the words dim and their waveform goes quiet.
5. **Option-↑ / Option-↓** (or the arrows on a paragraph's header) move a
   paragraph. Its clips move with it on every track.
6. In **Source**, select a line and press **V** to put it in the edit at the
   caret. **F** finds the edit's selection in the source. **Shift-F** goes the
   other way.
7. Press **Return** on a single selected word to correct its text. The media
   does not move.
8. Resize the window down to 1100×700, and use ⌃⌘S and ⌃⌘I.

### What to approve

- The layout: sidebar, source, edit, inspector over a full-width timeline.
- Delete means "cut the time on every track"; Shift-Delete means "silence this
  speaker only".
- Cuts are never invisible: a ¦ in the text, a marker on the ruler, a line
  through every lane.
- The crosstalk question, and its wording.
- Source/record: read-only source beside the edit, V to splice, F to match.
- How the timeline looks: one lane per speaker, in the speaker's colour,
  keeping the AAF's track numbers.

## The one model

The edit is an **ordered list of segments**. A segment is a range of source
time, and it plays on **every speaker's track at once**. Program time is the
running sum of segment lengths.

```
source  |---a---|xx|-----b-----|xxx|--c--|
edit    |---a---|-----b-----|--c--|          three segments, two cuts
lanes   A1 Rosa  ▇▇▇▇▇▇▇|▇▇▇▇▇▇▇▇▇▇▇|▇▇▇▇▇
        A2 Dev ▇▇▇▇▇▇|▇▇▇▇▇▇▇▇▇▇▇|▇▇▇▇▇     same boundaries on every lane
```

That is why the timeline is magnetic: there is nothing that could leave a gap.
It is Media Composer's Extract with every sync lock on, Pro Tools' Shuffle
across all tracks, and Final Cut's Blade All on every edit. The failure that
magnetic timelines are criticised for (a connected clip that rides along a
ripple and drifts out of sync) cannot happen, because no track is ever
connected to another; they are all the storyline.

A **speaker-only removal** is the one exception, and it never ripples. It is a
**mute** on one track over a source range: Avid's Lift, Final Cut's Replace
with Gap. Time on the other tracks is untouched.

Rules the model enforces, and the prototype's tests pin
(`design-system/transcript-editor-model.test.ts`):

- A deletion keeps a little air (up to 120 ms) around the words it removes,
  and never reaches into a neighbouring word on any track.
- A word belongs to the segment its midpoint falls in, so an edit can never
  leave half a word showing in the text.
- A cut never breaks a paragraph. Paragraphs break on a change of speaker or a
  pause of more than 1.2 s.
- The same source can be used twice (a line spliced in again). Selections are
  per **appearance**, so deleting one copy leaves the other.
- An edit point is one of three kinds:
  - a **cut** skips source that plays nowhere else, and can be restored;
  - a **through edit** skips nothing;
  - a **jump** goes somewhere on purpose (a move or a splice). What it skips
    still plays elsewhere, so it has nothing to restore. Restoring a jump
    would play those words twice, which is why the prototype refuses.
- Moving a paragraph keeps the running time exactly.

Times are seconds in the prototype. Phase 1 works in frames and samples: every
cut lands on a frame boundary, because Avid cannot represent anything finer
(see "Edit on frames" below).

## Editing in the text

| Action | Keys | What happens |
|---|---|---|
| Place the caret | Click | The caret goes before the word, and the playhead moves to it |
| Select words | Drag, Shift-click, Shift-← → | Selection snaps to whole words |
| Select all | ⌘A | |
| Delete for everyone | ⌫ or fn⌫ | Cuts the time on every track; the timeline closes up |
| Delete for one speaker | ⇧⌫ | Silences only those words on their track; nothing moves. Again restores |
| Correct text | Return, on one word | Edits the words only; the media never moves |
| Move a paragraph | ⌥↑ ⌥↓, or its header arrows | The paragraph's clips move on every track |
| Play / pause | Space | The current word lights up and the text follows it |
| Undo / redo | ⌘Z ⇧⌘Z | Undo names what it undoes ("Undo Delete 8 Words") |

- **The text is not a contenteditable.** The model owns the words, and the
  spans only draw them. Typing cannot change the media by accident, and
  VoiceOver reads a document with speaker headings rather than an editable
  field. An `aria-live` status line reports every edit.
- **A cut is never invisible.** Descript and Riverside hide deletions by
  default, and research on both says that is how an editor loses track of
  what they did. Here a cut leaves a **¦** in the text (it names the seconds
  removed and opens the cut), a marker on the ruler, and a line through every
  lane. **Show removed** puts the words back in place, struck through.
- **Crosstalk asks before it cuts.** When the time you delete also holds
  someone else's words, the editor chooses between cutting the time for
  everyone or silencing only the selected speaker. Return picks the first;
  Escape changes nothing. Riverside asks the same question.
- **Pauses show as dots**, scaled to their length: • from 0.35 s, •• from
  0.8 s, ••• from 1.5 s.
- **Speakers come from the mic, not from diarisation.** Each paragraph's rule
  and each lane are drawn in that speaker's colour.

## Source and record

The source pane is the whole scene, read-only. The edit is the record.

- Words already in the edit read at full strength; the rest are dimmed, so
  what the cut left out is visible at a glance. The pane header counts them.
- **V** splices the source selection into the edit at the caret. **Add to
  end** appends it. Both are Avid's verbs, on Avid's key.
- **F** is Match Frame: it finds the edit's selection in the source.
  **⇧F** is Reverse Match Frame: it finds a source word in the edit, or says
  it is not used.
- Overwrite (B), Lift (Z) and Extract (X) on marked ranges are Phase 1 work,
  not in the prototype.

## The timeline

- One lane per speaker, keeping the imported AAF's **track numbers** (A1, A2,
  …). A lane is a track, not a view: that is what Avid will get back.
- Each clip is a segment. Its waveform is that speaker's mic, in their
  colour; muted ranges draw faint.
- Every edit point has a marker on the ruler (a button that names it: "Cut at
  01:00:06:05, 4.79 s removed") and a line through every lane. A dashed line
  is a through edit. An amber tick on a lane means the cut clips one of that
  speaker's words, usually crosstalk.
- The selection shows as a band across every lane.
- Solo and Mute per lane are for listening only. They do not edit.
- **It never scrolls sideways on its own.** Zoom in, then pan with the slider.
  A Mac with a mouse attached always shows classic scroll bars, and a sideways
  bar across the tracks eats height and looks broken.
- Timecode is counted in frames from the start timecode. At 23.976, a second
  of media is not a second of timecode: adding 3,600 seconds and formatting
  lands 3.6 seconds short of 01:00:00:00, which is the bug the prototype's
  first draft had.

### Edit on frames, fade in preview

- Avid edits audio on frame boundaries in a sequence, and AAF cannot express a
  subframe cut. So every cut snaps to a frame, and preview plays exactly what
  Avid will get.
- Where a cut lands (Phase 2): start from the word timings, search the pause
  between words (about ±60 ms) for the lowest energy across all tracks, then
  snap to the nearest frame that does not enter a word on any track.
- Preview puts a 10 ms equal-power crossfade on every join. Descript's 5 ms
  reads as abrupt; above 50 ms it blurs speech.
- The AAF gets hard cuts by default. An option writes 2-frame audio dissolves,
  but only where every track has a pause at least that long.

## Panels

Four panes over a full-width timeline:

```
┌ toolbar ────────────────────────────────────────────────────────────┐
│ sidebar │ source │          edit (record)          │   inspector    │
│         │        │                                 │                │
├─────────┴────────┴─────── transport ───────────────┴────────────────┤
│ timeline: ruler + one lane per speaker                              │
└─────────────────────────────────────────────────────────────────────┘
```

| Pane | Min | Ideal | Max | Role |
|---|---|---|---|---|
| Sidebar | 180 | 220 | 320 | Where an edit comes from: AAF Audio sequences, Library transcripts, saved edits |
| Source | 280 | 320 | 480 | The whole scene, read-only |
| Edit | 440 | fills | | The document. Never collapses |
| Inspector | 240 | 270 | 360 | The selection, the edit point, the edit's totals, talk time, export |
| Timeline | 160 | 264, or 30% of the window | 50% | Transport plus a ruler and one lane per speaker |

- **When space runs out, panes leave; they do not shrink into uselessness.**
  The sidebar goes first, then the inspector, then the source, which folds into
  a **Source | Edit** switch in the toolbar. The edit's reading width never
  drops below about sixty characters.
- **The pane you opened last wins.** Asking for a pane always shows it, and
  something else steps aside. The rules are a pure function
  (`design-system/transcript-editor-layout.ts`) with tests.
- **Dividers** are 1 px hairlines with a 10 px grab area. Drag them, or focus
  one and use the arrow keys (Shift for bigger steps, Home and End for the
  limits); double-click resets. They say so in their tooltip.
- **Toolbar:** the sidebar toggle and title lead, the inspector toggle
  trails, and undo and redo name what they will do. ⌃⌘S toggles the sidebar
  and ⌃⌘I the inspector, matching SwiftUI's `SidebarCommands` and
  `InspectorCommands`.
- Nothing critical lives only in the timeline or at the bottom of the window,
  because people drag windows past the bottom of the screen. Every timeline
  action also has a key or an inspector button.

### SwiftUI-ready, and fine on older Macs

"SwiftUI compliant" here means two things. The window follows the macOS HIG
split-view conventions. And every pane maps onto a SwiftUI or AppKit container,
so a native version later is a port, not a redesign.

| Pane | SwiftUI | AppKit |
|---|---|---|
| Window | `WindowGroup.defaultSize`, `.windowResizability(.contentMinSize)` | `NSWindow.minSize` |
| Sidebar | `NavigationSplitView` sidebar with `List(selection:)` | Sidebar split item |
| Top row over timeline | `VSplitView` | Vertical `NSSplitViewController` |
| Source and edit | `HSplitView` children, each an `NSTextView` representable | `NSTextView`, the edit one with a delegate that vetoes typing |
| Inspector | `.inspector` with `inspectorColumnWidth(min:ideal:max:)` | Inspector split item (270) |
| Timeline | A custom `Canvas` | A custom `NSView` |
| Toolbar | `.toolbar` with navigation and primary-action placements | `NSToolbar` |

The editable text has to be `NSTextView`. On macOS 14, SwiftUI's `TextEditor`
edits a plain string only: selection binding needs 15, and styled text needs
26.

**Older Macs.** The app's floor is macOS 14, which means WKWebView could be
anything from Safari 17.0 to 26.x. The prototype is built for 17.0:

- No anchor positioning, `scrollbar-gutter`, View Transitions, `field-sizing`
  or `content-visibility`.
- `color-mix`, `:focus-within`, `display: contents` and grid are all in 17.0.
- The default window is 1680×1020 and the minimum 1100×700, matching
  `tauri.conf.json`. The prototype's browser test fits 1100×700 with no
  sideways overflow anywhere.
- An M1 Air at its default 1440×900 leaves about 800 px of height, and at
  "Larger Text" (1280×800) about 700. So the timeline defaults to 30% of the
  window rather than a fixed height.
- Scroll bars can always be visible (a mouse attached, or System Settings ▸
  Appearance). The text panes scroll vertically only, and the timeline never
  scrolls sideways.

## Design system

It follows [DESIGN.md](DESIGN.md) and the production stylesheet rules:

- **Colour:** tokens only.
  - Selection is the violet `--sel-fill`.
  - Emphasis, pressed toggles and the current word are brightness, not hue.
  - Green appears nowhere, because nothing here is a positive outcome or a
    live feed.
  - Warnings (a clipped word, crosstalk) use `--warning`.
  - Speaker colours are five well-separated hues from `SPEAKER_SOLIDS`.
- **Type:** chrome is Nunito Sans at the `--text-*` scale. The edit's prose is
  the transcript reader's serif at 15 px, so reading and editing a transcript
  look like the same thing.
- **Controls:** buttons are the catalog's 26 px compact recipe, icon buttons
  are the transport's `cp-icon-btn`, and the Source | Edit switch is
  `cp-segmented`. Every class carries the `cp-` prefix. There are no inline
  styles except computed positions and colours.
- **Motion:** only the caret blinks, and it stops under Reduce Motion.

## Where it lives in the app

- **A new workspace: "Transcript Editor"**, in the nav rail after AAF Audio.
- **It opens from:**
  - an AAF Audio sequence ("Open in Transcript Editor" once its mics are
    transcribed);
  - a Library transcript (single-track, one speaker per diarised voice);
  - its own sidebar of saved edits.
- **String-outs are edits.** [AAF-ASSEMBLY-RESEARCH.md](AAF-ASSEMBLY-RESEARCH.md)
  proposed a "Transcript | String-outs" switch inside AAF Audio. This design
  replaces it: an edit that starts empty and is filled with **V** from the
  source *is* a string-out. And when AI assembly arrives, a request produces an
  edit to review here rather than a separate list.
- **The document** is the edit model plus its source reference, stored
  beside the sequence's transcripts under
  `~/Documents/Sauce Bunny/Transcripts/Multitrack/`. It follows the rules the
  other Documents stores follow: a schema version, refusing a newer file,
  atomic writes and a flush on quit.

## Build order

This supersedes the build order in AAF-ASSEMBLY-RESEARCH.md. Each phase is
useful on its own.

- **Phase 0: prove the AAF round trip.** Unchanged, and it comes first, as
  asked.
  1. Turn the spike in `docs/research/aaf-stringout-spike/` into a sidecar
     command.
  2. Write a hand-made edit (three segments across five tracks) from a real
     group AAF.
  3. Run the Mac test plan: it relinks to NEXIS media, the track numbers
     survive, and every cut is on a frame.
- **Phase 1: the Transcript Editor, manual.** This prototype, hooked up.
  - **Word timings.** A prerequisite, because AAF cues are sentences today.
    whisper.cpp token timestamps are about ±0.5 s, so each word boundary is
    refined against its own mic's energy.
  - The edit model and its store; the workspace and panes; undo.
  - Edit-list playback of the ISOs from NEXIS, with 10 ms joins.
  - Source/record (V, B, F, ⇧F).
  - Export to Avid through the Phase 0 writer.
- **Phase 2: clean cuts.**
  - Cut placement: lowest energy in the pause, snapped to a frame.
  - The bleed check, and room tone for a speaker-only removal.
  - Pause tightening (threshold to target, previewed).
  - Filler words: delete, silence, or leave.
- **Phase 3: local AI assembly.** A request ("two minutes, open with Rosa")
  produces an edit, and a revision comes back as a diff you accept.
- **Phase 4: Claude and Ollama.** As in the research doc.

## Open questions

1. **Speaker-only removal:** export filler for the mixer to fill, or room tone
   baked in?
2. **Preview:** is snapping cuts to frames acceptable (you hear what Avid
   gets), or do you want sample accuracy while editing?
3. **Mix track:** should the production mix follow the edit, or be left out in
   favour of the ISOs?
4. **Dragging a paragraph:** Extract/Splice (everything closes up, as now) by
   default, or Lift/Overwrite?
5. **Bleed:** when a silenced word can still be heard on another lav, warn,
   or refuse the removal?
6. **Deletion granularity:** any word, or snap to phrase boundaries?
7. **Export layout:** keep the AAF's track numbers (as the prototype does), or
   re-lay tracks in speaker order? Write 2-frame dissolves by default?
8. **Neo Main:** its timeline rules and track assignment were asked to be the
   baseline, but the repository is not reachable from this session. Push it
   (a private repo is fine) or have a session on the Mac summarise its
   timeline model, and this section gets revised against it.

## Known gaps in the prototype

- No audio, no waveform from real media, no persistence.
- The sidebar is navigation-only; other sequences do not open.
- Overwrite, Lift and Extract on marked ranges, trims at an edit point
  (ripple, roll, slip), pause tightening, filler words and J/L cuts are not
  drawn yet.
- The waveform does not follow Solo and Mute; they only dim the lane.

## Sources

Most vendor sites blocked direct reads from this environment, so most of these
were read through search extracts; the research reports marked each claim
verified, reported or inferred.

**Text-based editing.**
- Descript:
  - [Deleting vs ignoring script text](https://help.descript.com/hc/en-us/articles/10164872017933-Deleting-vs-ignoring-script-text)
  - [Edit boundaries](https://help.descript.com/hc/en-us/articles/20952542722957-Edit-boundaries)
  - [Automatic microfades](https://help.descript.com/hc/en-us/articles/10249332124301-Automatic-microfades)
  - [Playback and navigation](https://help.descript.com/hc/en-us/articles/10164534109837-Playback-and-navigation)
  - [The wordbar](https://help.descript.com/hc/en-us/articles/10249346632717-The-wordbar)
  - [Correct your transcript](https://help.descript.com/hc/en-us/articles/10119613609229-Correct-your-transcript)
  - [Filler words](https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words)
  - [Room tone](https://help.descript.com/hc/en-us/articles/10255967999757-Room-tone)
  - [Editing crosstalk](https://www.descript.com/blog/article/how-to-edit-out-crosstalk-in-your-podcast-and-when-to-leave-it-alone)
  - [Mic bleed in multitrack](https://medium.com/descript/how-descript-handles-mic-bleed-in-multitrack-recordings-233013e02ed4)
- Riverside:
  - [Show deleted text](https://support.riverside.fm/hc/en-us/articles/10513205586077-Show-deleted-text-in-the-transcript)
  - [Remove a word or phrase](https://support.riverside.com/hc/en-us/articles/14488573075741-Remove-a-word-or-phrase-from-the-recording)
  - [Remove silences](https://support.riverside.com/hc/en-us/articles/12245776523677-Remove-individual-silences-and-pauses)
- Premiere Pro:
  - [Text-based editing](https://www.redsharknews.com/all-you-need-to-know-about-adobe-premiere-pros-text-based-editing)
  - [Pauses in transcripts](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts.html)
- Other tools:
  - [Avid Media Composer 2025.12](https://www.avid.com/resource-center/whats-new-avid-media-composer-202512)
  - [Hindenburg: edit with words](https://hindenburg.com/hindenburg-pro-2-features/edit-with-words/)
  - [Reduct](https://help.reduct.video/en/articles/2653196-how-do-i-cut-video)
- Research:
  - Rubin et al., [Content-based tools for editing audio stories](http://vis-ucb-maneesh.stanford.edu/papers/audiostories/) (UIST 2013)
  - [VideoDiff](https://arxiv.org/abs/2502.10190) (CHI 2025)
  - [ChunkyEdit](https://dl.acm.org/doi/10.1145/3613904.3642667) (CHI 2024)

**Timelines and editing verbs.**
- Final Cut Pro:
  - [The magnetic timeline](https://support.apple.com/guide/final-cut-pro/intro-to-the-magnetic-timeline-verb8fcfc133/mac)
  - [Connected clips](https://support.apple.com/guide/final-cut-pro/connect-clips-ver7a77ef9e/mac)
  - [Blade All](https://support.apple.com/guide/final-cut-pro/cut-clips-in-two-ver4e30479/mac)
  - [Audio lanes](https://support.apple.com/guide/final-cut-pro/organize-the-timeline-with-audio-lanes-verb71cb913/mac)
- Avid Media Composer:
  - [Basic editing](https://support.emerson.edu/hc/en-us/articles/21709228732699-Basic-Editing-in-Avid)
  - [Sync locks and trimming](https://www.chrisnicholas.net/tutorials/avid/trimming.html)
  - [Patching](https://www.editvideofaster.com/patching-avid-media-composer/)
  - [Reverse Match Frame](https://kb.avid.com/pkb/articles/en_US/How_To/Reverse-Match-Frame-in-Media-Composer)
  - [Multicam](https://support.emerson.edu/hc/en-us/articles/21709344829083-Multicam-Editing-in-Avid)
  - [Quick transitions](https://screenlight.tv/blog/2014/10/16/avid-media-composer-quick-transitions)
- Premiere Pro: [Sync lock](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sync-lock-to-prevent-changes.html)
- Audition:
  - [Multitrack clips](https://helpx.adobe.com/audition/using/arranging-editing-multitrack-clips.html)
  - [Fades and mixing](https://helpx.adobe.com/audition/using/clip-volume-matching-fading-mixing.html)
- DaVinci Resolve: [The Cut page](https://www.blackmagicdesign.com/products/davinciresolve/cut)
- Hindenburg: [auto-fades](https://www.willyurman.com/teaching/handouts/Hindenburg_Journalist.pdf)
- Pro Tools AAF: [Pro Tools-friendly AAFs](https://www.forte-ai.com/blog/how-to-create-a-pro-tools-friendly-aaf-from-avid-media-composer)
- Word timing: [WhisperX](https://github.com/m-bain/whisperX)

**Panels and platform.**
- Apple HIG:
  - [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views)
  - [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
  - [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
  - [Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)
- SwiftUI:
  - [`NavigationSplitView`](https://developer.apple.com/documentation/swiftui/navigationsplitview)
  - [`inspector`](https://developer.apple.com/documentation/swiftui/view/inspector(ispresented:content:))
  - [`HSplitView`](https://developer.apple.com/documentation/swiftui/hsplitview)
  - [TextKit 2 (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10090/)
- WebKit: [Safari 17.2 features](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/); MDN browser-compat-data for the feature floor.
