// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <obs.h>

namespace sauce_obs {
// A missing/old module must not be mistaken for a healthy capture source.
// This is a passive query: it cannot start, restart or broaden capture.
inline bool captureHealthy(proc_handler_t *procedures) {
    calldata_t result = {};
    const bool called = proc_handler_call(procedures, "sauce_capture_health", &result);
    const bool healthy = called && calldata_int(&result, "version") == 1 &&
                         calldata_bool(&result, "healthy");
    calldata_free(&result);
    return healthy;
}
}
