// SPDX-License-Identifier: GPL-2.0-or-later
#include "application-discovery.hpp"
#include <cassert>
#include <iostream>
using namespace sauce_obs;

int main() {
    assert(applicationResponseFits(64 * 1024 - 1));
    assert(!applicationResponseFits(64 * 1024));
    assert(!applicationResponseFits(64 * 1024 + 1));
    const auto choice = [](int32_t pid, const std::string &id, const std::string &name,
                           bool terminated = false, bool canActivate = true) {
        return applicationChoice(pid, id, name, terminated, canActivate, 900);
    };
    assert(choice(42, "com.avid.editor", "Media Composer"));
    assert(choice(42, "com.example.editor", "Éditeur 日本語"));
    assert(choice(42, "com.example.editor", "")->name == "com.example.editor");
    assert(!choice(0, "com.example.editor", "Editor"));
    assert(!choice(-1, "com.example.editor", "Editor"));
    assert(!choice(900, "com.example.editor", "Editor"));
    assert(!choice(42, "com.example.editor", "Editor", true));
    assert(!choice(42, "com.example.editor", "Editor", false, false));
    for (const auto &invalid : {"", "--applications", "/Applications/Editor.app", "com.editor\n", "editor"})
        assert(!choice(42, invalid, "Editor"));
    assert(!choice(42, std::string("com.editor\0hidden", 17), "Editor"));
    assert(!choice(42, "com.example.editor", std::string(4097, 'a')));
    assert(!choice(42, "com.example.editor", std::string("a\0b", 3)));

    // Same bundle/title in two processes must remain two choices; exact
    // duplicates collapse. Sorting is deterministic, not NSWorkspace order.
    auto result = applicationChoices({{3, "com.example.editor", "Editor"},
        {2, "com.example.editor", "Editor"}, {1, "com.avid.editor", "Avid"},
        {2, "com.example.editor", "Editor"}});
    assert(result.error.empty() && result.applications.size() == 3);
    assert(result.applications[0].process == 1 && result.applications[1].process == 2 &&
        result.applications[2].process == 3);
    assert(applicationChoices({}).error.empty());
    assert(applicationChoices({}).applications.empty());
    assert(!applicationChoices({{2, "com.one.app", "One"}, {2, "com.two.app", "Two"}}).error.empty());
    assert(!applicationChoices({{2, "com.one.app", "One"}, {2, "com.one.app", "Renamed"}}).error.empty());
    assert(applicationChoices(std::vector<Application>(1025, {1, "com.app.test", "Test"})).error ==
        "application_list_too_large");
    std::cout << "OBS application discovery identity tests passed\n";
}
