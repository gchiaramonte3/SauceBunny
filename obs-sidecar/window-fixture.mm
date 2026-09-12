// SPDX-License-Identifier: GPL-2.0-or-later
// Disposable source for ScreenCaptureKit tests. Silent unless --tone-a/b is
// explicit; those play only fixed, low-level generated stereo test tones.
// Controls affect only this process. No capture, microphone or input APIs.
#import <AppKit/AppKit.h>
#import <AVFAudio/AVFAudio.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <thread>
#include <unistd.h>

static NSWindow *fixture;
static AVAudioEngine *audioEngine;
static AVAudioPlayerNode *audioPlayer;
static int tonePair;
static void report(const char *event) {
    std::printf("{\"event\":\"%s\",\"pid\":%d,\"window\":%ld}\n", event, getpid(), (long)fixture.windowNumber);
    std::fflush(stdout);
}

@interface FixtureView : NSView
@end
@implementation FixtureView
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    [[NSColor colorWithSRGBRed:0.1 green:0.15 blue:0.3 alpha:1] setFill];
    NSRectFill(self.bounds);
    [[NSColor colorWithSRGBRed:0.2 green:0.7 blue:0.4 alpha:1] setFill];
    NSRectFill(NSMakeRect(24, 24, 120, 120));
    NSString *label = tonePair ? @"Sauce Bunny audio isolation test\nGenerated picture and quiet tones — no media"
                              : @"Sauce Bunny capture test\nGenerated picture only — no project or media";
    [label drawAtPoint:NSMakePoint(24, 190)
        withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:18], NSForegroundColorAttributeName:NSColor.whiteColor}];
}
@end

static bool startTones() {
    constexpr double sampleRate = 48000, amplitude = 0.01;
    const double frequencies[2] = {tonePair == 1 ? 440.0 : 880.0, tonePair == 1 ? 660.0 : 1320.0};
    AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate channels:2];
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:48000];
    if (!buffer.floatChannelData) return false;
    buffer.frameLength = 48000;
    for (unsigned channel = 0; channel < 2; channel++)
        for (unsigned frame = 0; frame < buffer.frameLength; frame++)
            buffer.floatChannelData[channel][frame] = amplitude * std::sin(2 * M_PI * frequencies[channel] * frame / sampleRate);
    audioEngine = [[AVAudioEngine alloc] init];
    audioPlayer = [[AVAudioPlayerNode alloc] init];
    [audioEngine attachNode:audioPlayer];
    [audioEngine connect:audioPlayer to:audioEngine.mainMixerNode format:format];
    [audioPlayer scheduleBuffer:buffer atTime:nil options:AVAudioPlayerNodeBufferLoops completionHandler:nil];
    NSError *error = nil;
    if (![audioEngine startAndReturnError:&error]) {
        std::fprintf(stderr, "Generated audio failed: %s\n", error.localizedDescription.UTF8String);
        return false;
    }
    [audioPlayer play];
    return true;
}

int main(int argc, char **argv) {
    if (argc == 2 && std::strcmp(argv[1], "--tone-a") == 0) tonePair = 1;
    else if (argc == 2 && std::strcmp(argv[1], "--tone-b") == 0) tonePair = 2;
    else if (argc != 1) return 2;
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];
        fixture = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 600, 320)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
            backing:NSBackingStoreBuffered defer:NO];
        fixture.title = @"Sauce Bunny — disposable capture test";
        fixture.releasedWhenClosed = NO;
        fixture.contentView = [[FixtureView alloc] initWithFrame:NSMakeRect(0, 0, 600, 320)];
        [fixture center];
        if (tonePair) {
            NSRect screen = NSScreen.mainScreen.visibleFrame;
            [fixture setFrameOrigin:NSMakePoint(NSMinX(screen) + (tonePair == 1 ? 24 : 360), NSMinY(screen) + 80)];
        }
        [fixture makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        if (tonePair && !startTones()) return 3;
        if (tonePair) [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
            (void)timer;
            AVAudioTime *render = audioPlayer.lastRenderTime;
            AVAudioTime *position = render ? [audioPlayer playerTimeForNodeTime:render] : nil;
            if (position.sampleTimeValid) {
                std::printf("{\"event\":\"audio-clock\",\"frames\":%lld}\n", (long long)position.sampleTime);
                std::fflush(stdout);
            }
        }];
        // Audio-engine start is not the audio oracle: the test decodes BOTH
        // apps independently to prove both were actually producing sound.
        report("ready");
        std::thread([] {
            char command = 0;
            while (read(STDIN_FILENO, &command, 1) == 1) {
                const char action = command;
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (action == 'R') {
                        [fixture setContentSize:NSMakeSize(720, 400)];
                        report("resized");
                    } else if (action == 'M') {
                        NSPoint origin = fixture.frame.origin;
                        origin.x += 24; origin.y += 24;
                        [fixture setFrameOrigin:origin];
                        report("moved");
                    } else if (action == 'H') {
                        [fixture orderOut:nil];
                        report("hidden");
                    } else if (action == 'C') {
                        [fixture close];
                        report("closed");
                    } else {
                        [NSApp terminate:nil];
                    }
                });
            }
            dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
        }).detach();
        // A lost test runner cannot leave an abandoned fixture on the desktop.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            [NSApp terminate:nil];
        });
        [NSApp run];
        [audioPlayer stop];
        [audioEngine stop];
    }
    return 0;
}
