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
  /// The decoder's confidence in this token, 0 to 1. Tokens built without one
  /// (tests, older callers) count as certain.
  public let confidence: Float
  public init(token: String, startTime: Double, endTime: Double, confidence: Float = 1) {
    self.token = token
    self.startTime = startTime
    self.endTime = endTime
    self.confidence = confidence
  }
}

/// One spoken word with the time the recognizer measured for it, written
/// beside the SRT so the app stops estimating word positions from their
/// length (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md, phase 1). Times are
/// seconds from the start of the file the recognizer was given.
public struct TimedWord: Codable, Equatable {
  public let text: String
  public let start: Double
  public let end: Double
  /// Mean confidence of the word's tokens, 0 to 1.
  public let confidence: Float
}

func startsWord(_ tok: CueToken) -> Bool {
  tok.token.hasPrefix(" ") || tok.token.hasPrefix("\u{2581}")
}

/// Group sub-word tokens into words, by the same rule `tokensToSrt` breaks
/// on: a word begins at a token with a leading space (or U+2581) and runs
/// until the next one. So "3.14", "U.S." and a trailing comma stay inside
/// the word they belong to, and a cue's words are exactly its text split on
/// spaces.
public func tokensToWords(_ tokens: [CueToken]) -> [TimedWord] {
  var words: [TimedWord] = []
  var run: [CueToken] = []
  func flush() {
    let text = run.map(\.token).joined().trimmingCharacters(in: .whitespacesAndNewlines)
    if let first = run.first, let last = run.last, !text.isEmpty {
      let confidence = run.map(\.confidence).reduce(0, +) / Float(run.count)
      words.append(TimedWord(text: text, start: first.startTime, end: max(last.endTime, first.startTime), confidence: confidence))
    }
    run = []
  }
  for tok in tokens {
    if startsWord(tok) && !run.isEmpty { flush() }
    run.append(tok)
  }
  flush()
  // Parakeet's token END times are estimates and overlap the next token by up
  // to about 80 ms on real speech ("We" 0.00-0.24, "drove" 0.16-0.48). A word
  // ends where the next one starts, never after it.
  for i in words.indices.dropLast() where words[i].end > words[i + 1].start && words[i + 1].start > words[i].start {
    let w = words[i]
    words[i] = TimedWord(text: w.text, start: w.start, end: words[i + 1].start, confidence: w.confidence)
  }
  return words
}

/// Put a vocabulary rescorer's replacements ("in video" -> "NVIDIA", or a cast
/// name spelled right) into measured words without losing their times. Each
/// (original, replacement) pair takes the next run of words, in order, whose
/// letters match `original`; the run becomes one word with the replacement's
/// text, the run's start and end, the punctuation the run ended with, and its
/// lowest confidence. A pair that matches nothing changes nothing.
public func applyReplacements(_ words: [TimedWord], _ pairs: [(String, String)]) -> [TimedWord] {
  var out = words
  var cursor = 0
  for (original, replacement) in pairs where plausibleReplacement(original, replacement) {
    let wanted = original.split(separator: " ").map { bare(String($0)) }.filter { !$0.isEmpty }
    guard !wanted.isEmpty, !replacement.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
    var at = cursor
    while at + wanted.count <= out.count {
      if (0..<wanted.count).allSatisfy({ bare(out[at + $0].text) == wanted[$0] }) { break }
      at += 1
    }
    guard at + wanted.count <= out.count else { continue }
    let run = out[at..<(at + wanted.count)]
    let tail = String(run.last!.text.reversed().prefix { !($0.isLetter || $0.isNumber) }.reversed())
    let merged = TimedWord(text: replacement + tail, start: run.first!.start, end: run.last!.end, confidence: run.map(\.confidence).min() ?? 1)
    out.replaceSubrange(at..<(at + wanted.count), with: [merged])
    cursor = at + 1
  }
  return out
}

func bare(_ text: String) -> String { text.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "'" } }

func editDistance(_ a: String, _ b: String) -> Int {
  let b = Array(b)
  var row = Array(0...b.count)
  for (i, ca) in a.enumerated() {
    var previous = row[0]
    row[0] = i + 1
    for (j, cb) in b.enumerated() {
      let next = min(row[j + 1] + 1, row[j] + 1, previous + (ca == cb ? 0 : 1))
      previous = row[j + 1]
      row[j + 1] = next
    }
  }
  return row[b.count]
}

/// Our own guard on the rescorer, because it needs one. MEASURED on Parakeet
/// v3 with FluidAudio 0.17.5 at its cautious similarity (0.7): given the
/// names "Xiomara" and "Saoirse" it rightly turned "Siomara" into "Xiomara"
/// and also turned "it was funny" into "it Saoirse", deleting two real words.
/// A replacement is a respelling: at most two words, sharing at least 60% of
/// their letters with the name.
public func plausibleReplacement(_ original: String, _ replacement: String) -> Bool {
  let (from, to) = (bare(original), bare(replacement))
  guard !from.isEmpty, !to.isEmpty, original.split(separator: " ").count <= 2 else { return false }
  return 1 - Double(editDistance(from, to)) / Double(max(from.count, to.count)) >= 0.6
}

/// A sentence ends here, and the word before it is not an abbreviation whose
/// period belongs to the word ("U.S.", "e.g.", "Mr.").
func endsSentence(_ text: String) -> Bool {
  guard let last = text.last, ".?!".contains(last) else { return false }
  let word = text.split(separator: " ").last.map(String.init) ?? text
  if word.range(of: #"^([A-Za-z]\.)+$"#, options: .regularExpression) != nil { return false }
  let titles: Set<String> = ["mr.", "mrs.", "ms.", "dr.", "st.", "vs.", "jr.", "sr.", "mt."]
  return !titles.contains(word.lowercased())
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
  /// Tokens accumulated for the cue being built.
  var cur: [CueToken] = []

  func textOf(_ toks: ArraySlice<CueToken>) -> String {
    toks.map(\.token).joined().trimmingCharacters(in: .whitespacesAndNewlines)
  }
  func emit(_ toks: ArraySlice<CueToken>) {
    let t = textOf(toks)
    guard let first = toks.first, let last = toks.last, !t.isEmpty else { return }
    cues.append((start: first.startTime, end: last.endTime, text: t))
  }
  /// Index of the last token that begins a word, past the first token.
  func lastWordStart(_ toks: [CueToken]) -> Int? {
    for i in stride(from: toks.count - 1, through: 1, by: -1) where startsWord(toks[i]) { return i }
    return nil
  }

  for tok in tokens {
    // A sentence that has ended breaks the cue at the next word, once the cue
    // is long enough not to fragment (`cueSentenceMin`). Checked BEFORE the
    // token joins, and only at a word start, so "3.14" can never split: its
    // "14" does not start a word.
    if startsWord(tok), !cur.isEmpty {
      let before = textOf(cur[...])
      if before.count >= cueSentenceMin && endsSentence(before) {
        emit(cur[...])
        cur = []
      }
    }
    cur.append(tok)
    let text = textOf(cur[...])

    // Break RETROACTIVELY, at the last word boundary already passed.
    //
    // The earlier fix armed a break and waited for the NEXT word-start token,
    // which meant a cue could run well past the cap before one arrived. That
    // matters because the on-video overlay paints exactly two 42-character
    // lines and DISCARDS anything that does not fit, replacing the tail with
    // an ellipsis - so an over-long cue lost words on screen while the
    // transcript reader still showed them. Splitting backwards keeps every
    // cue under the cap AND never cuts inside a word.
    if text.count >= cueSoftCap {
      if let i = lastWordStart(cur) {
        emit(cur[0..<i])
        cur = Array(cur[i...])
        continue
      }
    }
    // No word boundary anywhere in this run - a script with no spaces
    // (Japanese, Chinese) never produces one. Break wherever we are rather
    // than letting a single cue swallow the transcript.
    if textOf(cur[...]).count >= cueHardCap {
      emit(cur[...])
      cur = []
    }
  }
  emit(cur[...])

  var out = ""
  for (i, c) in cues.enumerated() {
    out += "\(i + 1)\n\(srtTimecode(c.start)) --> \(srtTimecode(c.end))\n\(c.text)\n\n"
  }
  return out
}
