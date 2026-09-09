# Sauce Bunny product context

Sauce Bunny is a desktop editorial media tool for editors and small client review sessions. Clip is the editing workspace. Review uses the same mounted player with People on the left and notes on the right. Preserve existing file review, marks, annotations, session history, invitations, and playback behavior.

## Current task: Premiere in Preview

The existing Preview monitor is the primary picture surface, including a private Premiere NDI connection before a room starts. Connection setup belongs alongside that monitor, never in a second small centered video dialog. Use the existing transport and volume controls. Premiere owns live playback; file timecode must not be used to anchor live notes.

Private preview and room publication are distinct actions. Connecting or starting a session must not silently publish. Camera and microphone remain independent. Host and Join are separate compact setup forms; access management remains available without occupying the default setup page.

## Visual constraints

Follow docs/DESIGN.md and existing Preview components. Preserve Nunito Sans, neutral controls, spacing tokens, panel geometry, and keyboard accessibility. Avoid a new visual theme, extra permanent NDI toolbars, or redundant volume controls. Connection diagnostics and installation help are secondary disclosures. Test at the 1100 × 700 minimum and a larger desktop window.

## Verification

Decoder continuity, last-frame retention, source ownership, drafts, and guest isolation are correctness requirements. Label latency as unmeasured until actual end-to-end media tests establish it. Do not equate a Live badge or small buffer with proven real-time performance.
