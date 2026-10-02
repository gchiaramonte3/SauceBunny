import Foundation
import SoundAnalysis
import AVFoundation

final class Observer: NSObject, SNResultsObserving {
    var rows: [[String: Any]] = []
    var failure: Error?
    var completed = false
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else {
            fatalError("Unexpected result type")
        }
        rows.append([
            "start_seconds": CMTimeGetSeconds(result.timeRange.start),
            "duration_seconds": CMTimeGetSeconds(result.timeRange.duration),
            "classifications": result.classifications.map {
                ["identifier": $0.identifier, "score": $0.confidence] as [String: Any]
            }
        ])
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { failure = error }
    func requestDidComplete(_ request: SNRequest) { completed = true }
}

enum ProbeError: String, Error {
    case requiresUncompressedAudio = "Use a decoded PCM WAV or AIFF fixture, not the original video"
    case incompleteAnalysis = "The sound analyzer did not report completion"
}

func run() throws {
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    var report: [String: Any] = ["classifier": "Apple SoundAnalysis version1",
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "labels": request.knownClassifications.sorted(),
        "window_seconds": CMTimeGetSeconds(request.windowDuration),
        "overlap": request.overlapFactor]
    if CommandLine.arguments.count > 1 {
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        // The prototype is only for generated/FFmpeg-decoded PCM fixtures. The OS
        // file analyzer raised an Objective-C exception on the MP4 source; Swift
        // cannot catch that. Do not treat this extension gate as a media validator.
        guard ["wav", "aiff", "aif"].contains(url.pathExtension.lowercased()) else {
            throw ProbeError.requiresUncompressedAudio
        }
        let started = Date()
        let analyzer = try SNAudioFileAnalyzer(url: url)
        let observer = Observer()
        try analyzer.add(request, withObserver: observer)
        analyzer.analyze()
        if let error = observer.failure { throw error }
        guard observer.completed else { throw ProbeError.incompleteAnalysis }
        report["elapsed_seconds"] = Date().timeIntervalSince(started)
        report["windows"] = observer.rows
    }
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    try run()
} catch {
    let message = (error as? ProbeError)?.rawValue ?? error.localizedDescription
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
