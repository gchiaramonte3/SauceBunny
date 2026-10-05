import XCTest
@testable import ProgramCaptureCore

final class ControlTests: XCTestCase {
    let token = "0123456789abcdef0123456789abcdef"

    func testHeartbeatAndQuitAreBareLetters() {
        XCTAssertEqual(Command.parse("P"), .heartbeat)
        XCTAssertEqual(Command.parse("Q"), .quit)
    }

    func testChooseStartStopAndCancelParseExactly() {
        XCTAssertEqual(Command.parse(#"{"op":"choose","request":3,"choice":"\#(token)","kind":"window"}"#), .choose(request: 3, choice: token, kind: .window))
        XCTAssertEqual(Command.parse(#"{"op":"cancel","request":3}"#), .cancel(request: 3))
        XCTAssertEqual(Command.parse(#"{"op":"start","slot":1,"generation":9,"choice":"\#(token)","audio":true}"#),
                       .start(slot: 1, generation: 9, choice: token, audio: true, region: nil))
        XCTAssertEqual(Command.parse(#"{"op":"start","slot":0,"generation":9,"choice":"\#(token)","audio":false,"region":[0.25,0.25,0.5,0.5]}"#),
                       .start(slot: 0, generation: 9, choice: token, audio: false, region: NormalizedRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5)))
        XCTAssertEqual(Command.parse(#"{"op":"stop","slot":0,"generation":9}"#), .stop(slot: 0, generation: 9))
    }

    func testAnythingHalfRightIsIgnored() {
        for line in [
            #"{"op":"start","slot":2,"generation":9,"choice":"\#(token)","audio":true}"#,           // no third slot
            #"{"op":"start","slot":0,"generation":0,"choice":"\#(token)","audio":true}"#,           // generations start at 1
            #"{"op":"start","slot":0,"generation":1.5,"choice":"\#(token)","audio":true}"#,         // not an integer
            #"{"op":"start","slot":0,"generation":9,"choice":"ABC","audio":true}"#,                 // not a minted token
            #"{"op":"start","slot":0,"generation":9,"choice":"\#(token)"}"#,                         // audio unspecified
            #"{"op":"start","slot":0,"generation":9,"choice":"\#(token)","audio":true,"region":[0.5,0,0.6,1]}"#, // off the display
            #"{"op":"start","slot":0,"generation":9,"choice":"\#(token)","audio":true,"region":[0,0,0,1]}"#,     // empty
            #"{"op":"choose","request":1,"choice":"\#(token)","kind":"desktop"}"#,                 // unknown kind
            #"{"op":"launch"}"#, "not json", "", String(repeating: "P", count: Command.maxLine + 1),
        ] {
            XCTAssertNil(Command.parse(line), line)
        }
    }
}
