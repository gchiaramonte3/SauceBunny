// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <math.h>

// Shared by the helper and its private ScreenCaptureKit module. Input is the
// normalized selection; result rounds inward to whole backing pixels, then
// converts that exact rectangle back to top-left logical display points.
struct sauce_display_crop { double x, y, width, height; uint32_t pixels_wide, pixels_high; };
static inline bool sauce_display_crop_make(double logical_width, double logical_height,
    double pixel_width, double pixel_height, double x, double y, double width, double height,
    struct sauce_display_crop *result)
{
    const double values[] = {logical_width, logical_height, pixel_width, pixel_height, x, y, width, height};
    for (unsigned i = 0; i < 8; i++) if (!isfinite(values[i])) return false;
    if (logical_width < 2 || logical_height < 2 || pixel_width < 2 || pixel_height < 2 ||
        logical_width > 16384 || logical_height > 16384 || pixel_width > 16384 || pixel_height > 16384 ||
        floor(logical_width) != logical_width || floor(logical_height) != logical_height ||
        floor(pixel_width) != pixel_width || floor(pixel_height) != pixel_height ||
        x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1 || !result) return false;
    const double left = ceil(x * pixel_width), top = ceil(y * pixel_height);
    const double right = floor((x + width) * pixel_width), bottom = floor((y + height) * pixel_height);
    const double logical_wide = (right - left) * logical_width / pixel_width;
    const double logical_high = (bottom - top) * logical_height / pixel_height;
    if (logical_wide <= 16 || logical_high <= 16) return false;
    *result = (struct sauce_display_crop){left * logical_width / pixel_width, top * logical_height / pixel_height,
        logical_wide, logical_high, (uint32_t)(right - left), (uint32_t)(bottom - top)};
    return true;
}
