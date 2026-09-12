// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>
#include <filesystem>
#include <string>

namespace sauce_obs {
// Release all sources/outputs before this private libobs lifetime ends.
class Engine final {
public:
    Engine() = default;
    ~Engine();
    Engine(const Engine &) = delete;
    Engine &operator=(const Engine &) = delete;
    bool initialize(const std::filesystem::path &root, uint32_t width, uint32_t height);
    // Configure the final crop raster before starting any output.
    bool resizeOutput(uint32_t width, uint32_t height);
    const std::string &error() const { return error_; }
private:
    bool started_ = false;
    std::string error_;
    std::string graphicsPath_;
};
void pumpEvents(double seconds);
bool hasInput(const char *id);
bool hasOutput(const char *id);
} // namespace sauce_obs
