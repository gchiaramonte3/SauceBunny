// Receive-only compatibility probe using the production receiver. Never starts
// an NDI sender, changes an editor, or publishes into a Sauce Bunny room.
#import <Foundation/Foundation.h>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>

extern "C" char* sauce_ndi_query(const char*, bool);
extern "C" void sauce_ndi_free(char*);
extern "C" void sauce_ndi_run_with_timing(const char*, const char*, void*,
    void(*)(void*, int, const uint8_t*, size_t), bool(*)(void*), uint64_t(*)(void*));

static volatile std::sig_atomic_t interrupted = 0;
static void interrupt(int) { interrupted = 1; }
struct Capture {
    std::ofstream media;
    std::mutex lock;
    std::atomic<bool> failed{false};
    const std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point end;
    NSMutableArray* timing = [NSMutableArray array];
    NSMutableArray* telemetry = [NSMutableArray array];
    size_t bytes = 0, segments = 0, observations = 0;
    Capture(const std::string& path, int seconds): media(path, std::ios::binary), end(start + std::chrono::seconds(seconds)) {}
};
static bool stopped(void* context) {
    auto& c = *(Capture*)context;
    return interrupted || c.failed || std::chrono::steady_clock::now() >= c.end;
}
static uint64_t timingEnabled(void*) { return 1; }
static void output(void* context, int kind, const uint8_t* bytes, size_t length) {
    auto& c = *(Capture*)context;
    std::lock_guard<std::mutex> guard(c.lock);
    if (kind == 1 || kind == 2) {
        // A diagnostic capture cannot grow indefinitely, even if its encoder
        // misbehaves. Its containing mktemp directory is private to the user.
        if (length > 2 * 1024 * 1024 || c.bytes + length > 64 * 1024 * 1024) { c.failed = true; return; }
        c.media.write((const char*)bytes, length); c.bytes += length;
        if (!c.media) c.failed = true;
        if (kind == 2) ++c.segments;
    } else if (kind == 3 || kind == 4) {
        if (length > 16384) { c.failed = true; return; }
        NSDictionary* sample = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:length] options:0 error:nil];
        if (![sample isKindOfClass:[NSDictionary class]]) { c.failed = true; return; }
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - c.start).count();
        NSMutableArray* ring = kind == 4 ? c.timing : c.telemetry;
        [ring addObject:@{ @"elapsedSeconds":@(elapsed), @"observation":sample }];
        if (ring.count > (kind == 4 ? 600u : 120u)) [ring removeObjectAtIndex:0];
        if (kind == 4) ++c.observations;
        if ([sample[@"phase"] isEqual:@"error"]) c.failed = true;
    }
}
int main(int argc, char** argv) { @autoreleasepool {
    if (argc == 3 && std::string(argv[2]) == "list") {
        char* result = sauce_ndi_query(argv[1], true);
        if (!result) return 2;
        NSData* data = [NSData dataWithBytes:result length:strlen(result)];
        NSDictionary* status = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        std::cout << result << "\n"; sauce_ndi_free(result);
        return [status[@"available"] boolValue] ? 0 : 2;
    }
    if (argc != 6 || std::string(argv[2]) != "capture") return 2;
    char* end = nullptr; const long seconds = strtol(argv[5], &end, 10);
    if (!end || *end || seconds < 1 || seconds > 60 || !*argv[3]) return 2;
    const std::string directory = argv[4];
    const std::string movie = directory + "/program.mp4", report = directory + "/observations.json";
    if ([[NSFileManager defaultManager] fileExistsAtPath:[NSString stringWithUTF8String:movie.c_str()]] ||
        [[NSFileManager defaultManager] fileExistsAtPath:[NSString stringWithUTF8String:report.c_str()]]) return 2;
    Capture capture(movie, (int)seconds);
    if (!capture.media) return 2;
    std::signal(SIGINT, interrupt); std::signal(SIGTERM, interrupt);
    sauce_ndi_run_with_timing(argv[1], argv[3], &capture, output, stopped, timingEnabled);
    capture.media.close();
    std::lock_guard<std::mutex> guard(capture.lock);
    // Local observations only: sender metadata may contain private text.
    // Raw NDI timecode remains a decimal string, never a verified sequence TC.
    NSData* json = [NSJSONSerialization dataWithJSONObject:@{
        @"timingVerified":@NO, @"interrupted":@(interrupted != 0), @"failed":@(capture.failed.load()),
        @"sourceName":[NSString stringWithUTF8String:argv[3]], @"segments":@(capture.segments),
        @"timingObservations":@(capture.observations), @"timing":capture.timing, @"telemetry":capture.telemetry
    } options:NSJSONWritingPrettyPrinted error:nil];
    if (!json || ![json writeToFile:[NSString stringWithUTF8String:report.c_str()] atomically:YES]) return 2;
    std::cout << "Captured " << capture.segments << " media segments; timing remains unverified.\n";
    return capture.failed || !capture.segments ? 4 : 0;
}}
