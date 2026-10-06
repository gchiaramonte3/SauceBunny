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

  /// The on-video overlay paints two 42-character lines and DISCARDS whatever
  /// does not fit, replacing the tail with an ellipsis. A cue longer than that
  /// budget loses words on screen while the reader still shows them, so the
  /// cap is not cosmetic.
  func testNoCueExceedsWhatTheCaptionOverlayCanPaint() {
    let s = String(repeating: "the question of how a local transcription pipeline should spend its time is not obvious ", count: 4)
    let texts = cueTexts(tokensToSrt(tokenize(s)))
    XCTAssertGreaterThan(texts.count, 2)
    for t in texts {
      XCTAssertLessThan(t.count, cueSoftCap + 1, "cue is \(t.count) chars, over the overlay's budget: \(t)")
    }
  }

  /// The GENERAL property, and the one that actually catches a bad split.
  ///
  /// The suffix assertions above are narrow: they name the exact strings two
  /// known bugs produced, and a split that breaks a word somewhere else slips
  /// past them. (A mutation that split before the LAST token instead of the
  /// last word-start passed every other test in this file.) Rejoining the cues
  /// with a single space must reproduce the source text: if any word was cut,
  /// a space appears inside it and this fails.
  func testCuesRejoinIntoExactlyTheSourceText() {
    for source in [
      "The measured throughput on the new machine landed at 3.14 times the old number and everyone was pleased with it.",
      "Sales across the U.S. market last year were well ahead of what the forecast had suggested by a wide margin.",
      "It specifies version 1.2.3 of the protocol and that detail matters more than anyone expected it to matter.",
      String(repeating: "the question of how a local pipeline should spend its time is not obvious ", count: 3),
    ] {
      let cues = cueTexts(tokensToSrt(tokenize(source)))
      XCTAssertFalse(cues.isEmpty, "no cues for: \(source)")
      let rejoined = cues.joined(separator: " ")
      let expected = source.split(separator: " ").joined(separator: " ")
      XCTAssertEqual(rejoined, expected, "a word was split across cues")
    }
  }

  /// Sweep a number ACROSS the cap boundary.
  ///
  /// The fixed sentences above never happen to cross the cap in the middle of
  /// "3.14", so a split that ignores word boundaries entirely (breaking before
  /// the last token rather than the last WORD START) passed every one of them.
  /// Only by sliding the number through the boundary does the difference show.
  func testANumberIsNeverSplitWhereverItFallsRelativeToTheCap() {
    for pad in 0..<40 {
      // Built with a single join so pad 0 cannot introduce a double space -
      // that is a fixture artefact, not a split.
      let filler = String(repeating: "word ", count: 8).trimmingCharacters(in: .whitespaces)
      let padding = pad == 0 ? "" : " " + String(repeating: "x", count: pad)
      let source = "\(filler)\(padding) measured at 3.14 times the previous value across the whole run"
      let cues = cueTexts(tokensToSrt(tokenize(source)))
      XCTAssertFalse(cues.isEmpty, "pad \(pad) produced no cues")
      let rejoined = cues.joined(separator: " ")
      let expected = source.split(separator: " ").joined(separator: " ")
      XCTAssertEqual(rejoined, expected, "pad \(pad): a word or number was split across cues")
      for c in cues {
        XCTAssertLessThan(c.count, cueSoftCap + 1, "pad \(pad): cue over the overlay budget")
      }
    }
  }

  func testTimecodeFormatting() {
    XCTAssertEqual(srtTimecode(0), "00:00:00,000")
    XCTAssertEqual(srtTimecode(-5), "00:00:00,000", "negative time must clamp, not format garbage")
    XCTAssertEqual(srtTimecode(3661.5), "01:01:01,500")
  }

  // ── Words (accuracy spec, phase 1) ──

  /// A word is every token from one word start to the next, so a number, an
  /// abbreviation and trailing punctuation stay inside the word, and the words
  /// of a transcript are exactly its text split on spaces.
  func testWordsAreTheTextSplitOnSpacesWithTheirOwnTimes() {
    let s = "Sales across the U.S. landed at 3.14 times, she said."
    let tokens = tokenize(s)
    let words = tokensToWords(tokens)
    XCTAssertEqual(words.map(\.text), s.split(separator: " ").map(String.init))
    let number = words.first { $0.text == "3.14" }!
    // "3.14" is several tokens here, none starting a word, and keeps all their time.
    XCTAssertLessThan(number.start, number.end)
    XCTAssertTrue(zip(words, words.dropFirst()).allSatisfy { $0.end <= $1.start }, "words overlap or run backwards")
  }

  func testAWordsConfidenceIsTheMeanOfItsTokens() {
    let tokens = [CueToken(token: " hel", startTime: 0, endTime: 0.1, confidence: 0.9),
                  CueToken(token: "lo", startTime: 0.1, endTime: 0.2, confidence: 0.5),
                  CueToken(token: " you", startTime: 0.3, endTime: 0.4, confidence: 0.2)]
    let words = tokensToWords(tokens)
    XCTAssertEqual(words.map(\.text), ["hello", "you"])
    XCTAssertEqual(words[0].confidence, 0.7, accuracy: 0.0001)
    XCTAssertEqual(words[0].start, 0); XCTAssertEqual(words[0].end, 0.2)
    XCTAssertEqual(tokensToWords([]), [])
  }

  /// Measured on Parakeet v3: token end times overlap the next token's start.
  func testAWordEndsWhereTheNextBegins() {
    let tokens = [CueToken(token: " We", startTime: 0, endTime: 0.24), CueToken(token: " drove", startTime: 0.16, endTime: 0.48),
                  CueToken(token: " out", startTime: 0.48, endTime: 0.64)]
    let words = tokensToWords(tokens)
    XCTAssertEqual(words.map(\.end), [0.16, 0.48, 0.64])
  }

  /// The constant always said cues break on a sentence end; nothing did.
  func testACueBreaksAtASentenceEndOnceItIsLongEnough() {
    let s = "We drove out to the lake before sunrise. Nobody else was awake yet."
    let texts = cueTexts(tokensToSrt(tokenize(s)))
    XCTAssertEqual(texts, ["We drove out to the lake before sunrise.", "Nobody else was awake yet."])
    // Too short to stand alone: kept with what follows.
    XCTAssertEqual(cueTexts(tokensToSrt(tokenize("Okay. We drove out."))), ["Okay. We drove out."])
  }

  func testAnAbbreviationOrATitleIsNotASentenceEnd() {
    let s = "The interview was recorded across the whole U.S. market and then Mr. Smith left the room."
    let texts = cueTexts(tokensToSrt(tokenize(s)))
    for t in texts {
      XCTAssertFalse(t.hasSuffix("U.S."), "broke after an abbreviation: \(texts)")
      XCTAssertFalse(t.hasSuffix("Mr."), "broke after a title: \(texts)")
    }
  }

  // ── Vocabulary (accuracy spec, phase 2) ──

  private func w(_ text: String, _ start: Double, _ confidence: Float = 0.9) -> TimedWord {
    TimedWord(text: text, start: start, end: start + 0.3, confidence: confidence)
  }

  func testAReplacementKeepsTheTimesOfTheWordsItReplaces() {
    let words = [w("Then", 0), w("Rosie", 0.4, 0.4), w("said,", 0.8), w("Mac", 1.2), w("Kenzie", 1.5), w("left.", 1.8)]
    let out = applyReplacements(words, [("Rosie", "Rosa"), ("Mac Kenzie", "MacKenzie")])
    XCTAssertEqual(out.map(\.text), ["Then", "Rosa", "said,", "MacKenzie", "left."])
    XCTAssertEqual(out[1].start, 0.4); XCTAssertEqual(out[1].confidence, 0.4)
    // Two words became one, spanning both.
    XCTAssertEqual(out[3].start, 1.2); XCTAssertEqual(out[3].end, 1.8, accuracy: 0.0001)
  }

  /// The swap measured on real Parakeet output: "was funny" is not a way of
  /// spelling "Saoirse", and taking it would delete two words that were said.
  func testAReplacementThatIsNotARespellingIsRefused() {
    let words = [w("Xiomara", 0), w("did", 0.4), w("not", 0.6), w("think", 0.8), w("it", 1.0), w("was", 1.2), w("funny.", 1.4)]
    let out = applyReplacements(words, [("was funny", "Saoirse"), ("Xiomara", "Xiomara")])
    XCTAssertEqual(out.map(\.text), words.map(\.text))
    XCTAssertTrue(plausibleReplacement("Siomara", "Xiomara"))
    XCTAssertFalse(plausibleReplacement("in the video", "NVIDIA"), "three words are not one name")
  }

  func testAReplacementKeepsPunctuationAndMatchesNothingItShouldNot() {
    let out = applyReplacements([w("ask", 0), w("rosie.", 0.4)], [("Rosie", "Rosa"), ("Devon", "Dev")])
    XCTAssertEqual(out.map(\.text), ["ask", "Rosa."])
    XCTAssertEqual(applyReplacements([w("hello", 0)], [("", "x"), ("hello", " ")]).map(\.text), ["hello"])
  }
}
