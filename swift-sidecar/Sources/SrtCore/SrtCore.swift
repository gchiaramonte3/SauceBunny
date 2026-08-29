import Foundation

/// Cue construction for the Parakeet ASR path.
///
/// Extracted from the diarize sidecar's main.swift so it can be TESTED. It had
/// never been executed by any automated tier - CI compiles the Swift sidecars
/// and nothing runs them - and a real bug shipped through that gap twice in a
/// row (see the notes on `tokensToSrt`). This target deliberately depends on
/// nothing: no FluidAudio, no SpeakerKit, so `swift test` is fast and needs no
/// models on disk.

/// One ASR token with its timing. A local mirror of FluidAudio's `TokenTiming`,
/// so this target carries no dependency; the sidecar maps at the call site.
public struct CueToken: Equatable {
  public let token: String
  public let startTime: Double
  public let endTime: Double
  public init(token: String, startTime: Double, endTime: Double) {
    self.token = token
    self.startTime = startTime
    self.endTime = endTime
  }
}

/// Soft cap: roughly two overlay lines.
public let cueSoftCap = 84
/// Break once a sentence ends and the cue is long enough not to fragment.
public let cueSentenceMin = 32
/// Hard cap. A cue may exceed the soft cap while it waits for a word boundary,
/// but it may never run away - see `tokensToSrt`.
public let cueHardCap = 168

public func srtTimecode(_ seconds: Double) -> String {
  let ms = Int((max(0, seconds) * 1000).rounded())
  return String(format: "%02d:%02d:%02d,%03d",
                ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

/// Turn timed ASR tokens into SRT cues, never cutting inside a word.
///
/// Parakeet emits SUB-WORD tokens, and this has now been got wrong twice:
///
///   1. The original applied the length cap the instant it was exceeded, so a
///      cue ended "...is not obvio" and the next began "us. Most of the...".
///   2. The fix for that armed a deferred break for the LENGTH cap but left the
///      SENTENCE-END branch flushing immediately, "because a sentence end is
///      already a word end". That is false for this vocabulary and the model's
///      own vocab file proves it: of 8192 entries only two end in "." ("." and
///      ",."), so every period is a token of its own, and there are NO
///      space-prefixed digit tokens. A decimal number is therefore a run of
///      tokens none of which begins a word, and "landed at 3.14 times" broke as
///      "...landed at 3." / "14 times...". Same for "U.S." and "version 1.2.3".
///
/// So there is ONE break rule and no exceptions to it: a cap only ARMS a break;
/// the break happens at the next token that starts a word. Word starts are a
/// leading space (this model's vocabulary uses literal spaces - 4172 of its
/// 8192 entries - and no U+2581) or U+2581, which other sentencepiece models use.
///
/// The hard cap is the safety net for the case that rule cannot handle: a script
/// with no spaces at all (Japanese, Chinese) never produces a word-start token,
/// so an armed break would never fire and the whole transcript would collapse
/// into ONE cue. Past `cueHardCap` the cue breaks wherever it is.
public func tokensToSrt(_ tokens: [CueToken]) -> String {
  var cues: [(start: Double, end: Double, text: String)] = []
  var text = ""
  var start: Double? = nil
  var end = 0.0

  func flush() {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let s = start, !t.isEmpty { cues.append((start: s, end: end, text: t)) }
    text = ""; start = nil; end = 0
  }

  var wantBreak = false
  for tok in tokens {
    let startsWord = tok.token.hasPrefix(" ") || tok.token.hasPrefix("\u{2581}")
    if wantBreak && startsWord {
      flush()
      wantBreak = false
    }
    if start == nil { start = tok.startTime }
    text += tok.token
    end = tok.endTime

    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let endsSentence = trimmed.hasSuffix(".") || trimmed.hasSuffix("?") || trimmed.hasSuffix("!")
    if (endsSentence && trimmed.count >= cueSentenceMin) || trimmed.count >= cueSoftCap {
      wantBreak = true
    }
    // Runaway guard. Breaking mid-word here is the lesser evil against a single
    // cue holding an entire transcript.
    if trimmed.count >= cueHardCap {
      flush()
      wantBreak = false
    }
  }
  flush()

  var out = ""
  for (i, c) in cues.enumerated() {
    out += "\(i + 1)\n\(srtTimecode(c.start)) --> \(srtTimecode(c.end))\n\(c.text)\n\n"
  }
  return out
}
