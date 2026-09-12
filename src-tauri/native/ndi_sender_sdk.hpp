// SPDX-License-Identifier: MIT
#pragma once
#include "ndi_sender.hpp"
#include <memory>

namespace sauce_ndi {
// Calling this may initialize and advertise an NDI source. The executable must
// validate its explicit --broadcast authorization and input before calling it.
// Tests replace this factory at link time and never load the vendor runtime.
std::unique_ptr<Sink> create_sdk_sink(const char* absolute_runtime_path) noexcept;
} // namespace sauce_ndi
