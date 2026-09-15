// SPDX-License-Identifier: GPL-2.0-or-later
// Generated GPU textures only. No OBS sources, windows, capture APIs or audio.
#import <AppKit/AppKit.h>
#include <graphics/graphics.h>
#include <util/base.h>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <vector>

namespace {
uint8_t pattern(uint32_t row, uint32_t column) {
    // Distinct rows and vertical stripes expose both row drift and pixel loss.
    return static_cast<uint8_t>((row * 29 + (column / 11) * 43 + column % 11) % 251);
}

bool checkSurface(uint32_t width, uint32_t height, gs_color_format format, uint32_t bytesPerPixel) {
    const uint32_t rowBytes = width * bytesPerPixel;
    const uint32_t paddedRowBytes = (rowBytes + 3u) & ~3u;
    // Texture upload uses GL's default four-byte UNPACK alignment. Its padding
    // is deliberate; the oracle never assumes upload and readback are tight.
    std::vector<uint8_t> input(static_cast<size_t>(paddedRowBytes) * height, 0xFD);
    for (uint32_t row = 0; row < height; ++row)
        for (uint32_t column = 0; column < rowBytes; ++column)
            input[static_cast<size_t>(row) * paddedRowBytes + column] = pattern(row, column);
    const uint8_t *pixels = input.data();
    gs_texture_t *texture = gs_texture_create(width, height, format, 1, &pixels, 0);
    gs_stagesurf_t *surface = gs_stagesurface_create(width, height, format);
    if (!texture || !surface) {
        std::fprintf(stderr, "Cannot create generated %ux%u texture/surface\n", width, height);
        gs_texture_destroy(texture);
        gs_stagesurface_destroy(surface);
        return false;
    }
    gs_stage_texture(surface, texture);
    gs_flush();
    uint8_t *mapped = nullptr;
    uint32_t stride = 0;
    const bool didMap = gs_stagesurface_map(surface, &mapped, &stride);
    bool correct = didMap && mapped && stride >= rowBytes && stride <= paddedRowBytes;
    size_t mismatches = 0;
    if (correct) {
        for (uint32_t row = 0; row < height; ++row)
            for (uint32_t column = 0; column < rowBytes; ++column)
                mismatches += mapped[static_cast<size_t>(row) * stride + column] != pattern(row, column);
        correct = mismatches == 0;
    }
    std::printf("%s %ux%u bpp=%u reportedStride=%u expectedPackedStride=%u mismatches=%zu\n",
                correct ? "PASS" : "FAIL", width, height, bytesPerPixel, stride, paddedRowBytes, mismatches);
    if (didMap) gs_stagesurface_unmap(surface);
    gs_stagesurface_destroy(surface);
    gs_texture_destroy(texture);
    return correct;
}
} // namespace

int main(int argc, const char *argv[]) {
    if (argc != 2) { std::fprintf(stderr, "usage: stagesurface-stride-tests <private-renderer.dylib>\n"); return 2; }
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        const std::filesystem::path renderer(argv[1]);
        if (!renderer.is_absolute() || !std::filesystem::is_regular_file(renderer)) return 2;
        graphics_t *graphics = nullptr;
        if (gs_create(&graphics, renderer.c_str(), 0) != GS_SUCCESS || !graphics) return 3;
        gs_enter_context(graphics);
        bool passed = true;
        size_t cases = 0;
        for (const uint32_t width : {2u, 6u, 1266u, 1280u, 1920u}) {
            const uint32_t height = width == 1266 ? 1080 : 34;
            // Actual NV12 luma/chroma plane shapes, plus packed RGB control.
            passed = checkSurface(width, height, GS_R8, 1) && passed; ++cases;
            passed = checkSurface(width / 2, height / 2, GS_R8G8, 2) && passed; ++cases;
            passed = checkSurface(width, height, GS_BGRA, 4) && passed; ++cases;
        }
        gs_leave_context();
        gs_destroy(graphics);
        std::printf("Generated stagesurface stride: %zu cases, %s\n", cases, passed ? "passed" : "FAILED");
        return passed ? 0 : 1;
    }
}
