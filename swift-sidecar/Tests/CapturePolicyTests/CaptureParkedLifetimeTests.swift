import Darwin
import Dispatch
import Foundation

private final class ResourceProbe {
    deinit {
        FileHandle.standardOutput.write(Data("resources-released-too-early\n".utf8))
        _exit(66)
    }
}

@main
private struct CaptureParkedLifetimeTests {
    static func main() async {
        let resources = ResourceProbe()
        FileHandle.standardError.write(Data("meta:{\"width\":892,\"height\":798}\n".utf8))
        // Give the fixture parent time to reproduce closing stderr after
        // metadata. No desktop, capture or audio API is called in this test.
        try? await Task.sleep(nanoseconds: 100_000_000)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(400)) {
            FileHandle.standardOutput.write(Data("resources-alive; no capture APIs called\n".utf8))
            _exit(0)
        }
        if CommandLine.arguments.contains("--old-discarded-continuation") {
            await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
            withExtendedLifetime(resources) {}
        } else {
            await parkCaptureStream(retaining: resources)
        }
    }
}
