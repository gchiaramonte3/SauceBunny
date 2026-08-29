import XCTest
@testable import SrtCore

/// Cue breaking, against the REAL tokenization Parakeet v3 produces.
///
/// Derived from the model's own vocab file
/// (models/parakeet-tdt-0.6b-v3/parakeet_v3_vocab.json, 8192 entries): word
/// starts carry a LITERAL leading space (4172 entries; zero use U+2581), only
/// "." and ",." end in a period so every period is its own token, and there
/// are NO space-prefixed digit tokens, so a number is a run of tokens none of
/// which starts a word. Those three facts are what the cases below encode.
final class CueBreakTests: XCTestCase {

  /// Split a plain sentence the way this vocabulary would: leading spaces on
  /// word starts, periods and digits as their own tokens.
  private func tokenize(_ s: String) -> [CueToken] {
    var out: [CueToken] = []
    var t = 0.0
    var i = s.startIndex
    while i < s.index(before: s.endIndex) || i < s.endIndex {
      let ch = s[i]
      var piece: String
      if ch == " " {
        // A word: the space plus the following letters.
        var j = s.index(after: i)
        var w = " "
        while j < s.endIndex, s[j].isLetter { w.append(s[j]); j = s.index(after: j) }
        piece = w; i = j
      } else if ch.isLetter {
        var j = i
        var w = ""
        while j < s.endIndex, s[j].isLetter { w.append(s[j]); j = s.index(after: j) }
        piece = w; i = j
      } else {
        piece = String(ch); i = s.index(after: i)
      }
      out.append(CueToken(token: piece, startTime: t, endTime: t + 0.1))
      t += 0.1
      if i >= s.endIndex { break }
    }
    return out
  }

  private func cueTexts(_ srt: String) -> [String] {
    srt.split(separator: "\n\n").compactMap { block in
      let lines = block.split(separator: "\n", omittingEmptySubsequences: false)
      return lines.count >= 3 ? String(lines[2]) : nil
    }
  }

  /// The regression this file exists for. A decimal number must not be cut in
  /// half by the sentence-end branch: "3.14" was becoming "3." / "14".
  func testADecimalNumberIsNeverSplitAcrossCues() {
    let s = "The measured throughput on the new machine landed at 3.14 times the old number and everyone was pleased with it."
    let texts = cueTexts(tokensToSrt(tokenize(s)))
    XCTAssertFalse(texts.isEmpty, "tokenizer produced no cues; the test would prove nothing")
    for t in texts {
      XCTAssertFalse(t.hasSuffix("3."), "cue ends mid-number: \(t)")
    }
    XCTAssertTrue(texts.contains { $0.contains("3.14") }, "3.14 was split: \(texts)")
  }

  /// Same defect, reached through a dotted abbreviation: "U.S." became
  /// "...the U." / "S. market...".
  func testADottedAbbreviationIsNeverSplitAcrossCues() {
    let s = "Sales across the U.S. market last year were well ahead of what the forecast had suggested."
    let texts = cueTexts(tokensToSrt(tokenize(s)))
    XCTAssertFalse(texts.isEmpty)
    for t in texts {
      XCTAssertFalse(t.hasSuffix("U."), "cue ends mid-abbreviation: \(t)")
    }
  }

  /// The original bug: a sub-word token run cut by the LENGTH cap.
  func testALengthCapBreakLandsOnAWordBoundary() {
    // Long enough to cross the soft cap several times.
    let s = String(repeating: "the question of how a local transcription pipeline should spend its time is not obvious ", count: 3)
    let texts = cueTexts(tokensToSrt(tokenize(s)))
    XCTAssertGreaterThan(texts.count, 1, "expected several cues")
    for t in texts {
      XCTAssertFalse(t.hasSuffix("obvio"), "cue ends mid-word: \(t)")
    }
  }

  /// The runaway guard. A script with no spaces produces no word-start token
  /// ever, so an armed break can never fire; without a hard cap the whole
  /// transcript collapses into a single cue.
  func testACueCannotRunAwayWhenNoTokenEverStartsAWord() {
    let tokens = (0..<400).map { i in
      CueToken(token: "あ", startTime: Double(i) * 0.1, endTime: Double(i) * 0.1 + 0.1)
    }
    let texts = cueTexts(tokensToSrt(tokens))
    XCTAssertGreaterThan(texts.count, 1, "400 space-less tokens collapsed into \(texts.count) cue(s)")
    for t in texts {
      XCTAssertLessThanOrEqual(t.count, cueHardCap + 4, "cue exceeded the hard cap: \(t.count)")
    }
  }

  func testEmptyAndWhitespaceOnlyInputProduceNoCues() {
    XCTAssertEqual(tokensToSrt([]), "")
    let blanks = (0..<5).map { CueToken(token: "   ", startTime: Double($0), endTime: Double($0) + 1) }
    XCTAssertEqual(tokensToSrt(blanks), "", "whitespace-only tokens produced a cue")
  }

  /// A single token longer than the cap must still emit exactly one cue rather
  /// than looping or dropping it.
  func testOneOversizeTokenStillEmitsACue() {
    let big = String(repeating: "x", count: cueHardCap * 2)
    let texts = cueTexts(tokensToSrt([CueToken(token: big, startTime: 0, endTime: 1)]))
    XCTAssertEqual(texts.count, 1)
    XCTAssertEqual(texts.first?.count, big.count)
  }

  /// Timings must stay monotonic and match the tokens the cue actually holds.
  func testCueTimingsAreMonotonicAndNonNegative() {
    let s = String(repeating: "a reasonably long sentence that will certainly be broken into several cues here ", count: 3)
    let srt = tokensToSrt(tokenize(s))
    let stamps = srt.split(separator: "\n").filter { $0.contains(" --> ") }
    XCTAssertGreaterThan(stamps.count, 1)
    var lastEnd = -1.0
    for line in stamps {
      let parts = line.components(separatedBy: " --> ")
      let toSec: (String) -> Double = { tc in
        let hms = tc.replacingOccurrences(of: ",", with: ":").split(separator: ":").map { Double($0) ?? 0 }
        return hms.count == 4 ? hms[0] * 3600 + hms[1] * 60 + hms[2] + hms[3] / 1000 : -1
      }
      let s0 = toSec(parts[0]), e0 = toSec(parts[1])
      XCTAssertGreaterThanOrEqual(s0, 0)
      XCTAssertGreaterThanOrEqual(e0, s0, "cue ends before it starts")
      XCTAssertGreaterThanOrEqual(s0, lastEnd - 0.0001, "cues overlap or go backwards")
      lastEnd = e0
    }
  }

  func testTimecodeFormatting() {
    XCTAssertEqual(srtTimecode(0), "00:00:00,000")
    XCTAssertEqual(srtTimecode(-5), "00:00:00,000", "negative time must clamp, not format garbage")
    XCTAssertEqual(srtTimecode(3661.5), "01:01:01,500")
  }
}
