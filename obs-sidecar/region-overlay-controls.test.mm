// SPDX-License-Identifier: GPL-2.0-or-later
// Opt-in AppKit control test, not capture or global accessibility automation.
// Compile the production implementation into this test to exercise its private
// control factory without exposing a test hook or presenting a RegionOverlay.
#include "region-overlay.mm"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string_view>
using namespace sauce_obs;

// Construct events only for these test-owned hidden panels. Deliver directly
// to the production view methods; never post to NSApp, CGEvent or global AX.
static NSEvent *ownedMouseEvent(SBRegionButton *button, NSEventType type, NSPoint localPoint) {
    assert(button.window && !button.window.visible);
    NSEvent *event = [NSEvent mouseEventWithType:type location:[button convertPoint:localPoint toView:nil]
        modifierFlags:0 timestamp:0 windowNumber:button.window.windowNumber context:nil
        eventNumber:1 clickCount:1 pressure:0];
    assert(event); return event;
}

static void checkMouseActions(const RegionControls &controls, const std::shared_ptr<OverlayEvents> &events) {
    events->action.store(RegionAction::None);
    const NSPoint inside = NSMakePoint(NSMidX(controls.edit.bounds), NSMidY(controls.edit.bounds));
    const NSPoint outside = NSMakePoint(NSMaxX(controls.edit.bounds) + 4, NSMidY(controls.edit.bounds));
    NSEvent *down = ownedMouseEvent(controls.edit, NSEventTypeLeftMouseDown, inside);
    NSEvent *up = ownedMouseEvent(controls.edit, NSEventTypeLeftMouseUp, inside);

    controls.edit.enabled = NO;
    [controls.edit mouseDown:down]; [controls.edit mouseUp:up];
    assert(!controls.edit.pressed && events->action.load() == RegionAction::None);

    controls.edit.enabled = YES;
    [controls.edit mouseDown:down];
    assert(controls.edit.pressed && events->action.load() == RegionAction::None);
    [controls.edit mouseUp:up];
    assert(!controls.edit.pressed && events->action.exchange(RegionAction::None) == RegionAction::Edit);
    [controls.edit mouseUp:up]; // A release without another press cannot fire twice.
    assert(events->action.load() == RegionAction::None);

    [controls.edit mouseDown:down];
    [controls.edit mouseDragged:ownedMouseEvent(controls.edit, NSEventTypeLeftMouseDragged, outside)];
    [controls.edit mouseUp:ownedMouseEvent(controls.edit, NSEventTypeLeftMouseUp, outside)];
    assert(!controls.edit.pressed && events->action.load() == RegionAction::None);

    [controls.edit mouseDown:down]; // Disabling a held command also suppresses release.
    controls.edit.enabled = NO;
    [controls.edit mouseUp:up];
    assert(!controls.edit.pressed && events->action.load() == RegionAction::None);
    controls.edit.enabled = YES;

    const NSPoint stopInside = NSMakePoint(NSMidX(controls.stop.bounds), NSMidY(controls.stop.bounds));
    NSEvent *stopDown = ownedMouseEvent(controls.stop, NSEventTypeLeftMouseDown, stopInside);
    NSEvent *stopUp = ownedMouseEvent(controls.stop, NSEventTypeLeftMouseUp, stopInside);
    [controls.stop mouseDown:stopDown];
    assert(events->action.load() == RegionAction::None);
    [controls.stop mouseUp:stopUp];
    assert(events->action.exchange(RegionAction::None) == RegionAction::Stop);
    [controls.stop mouseUp:stopUp];
    assert(events->action.load() == RegionAction::None);
    [controls.edit mouseDown:down]; [controls.edit mouseUp:up];
    assert(events->action.load() == RegionAction::Edit);
    [controls.stop mouseDown:stopDown]; [controls.stop mouseUp:stopUp];
    assert(events->action.load() == RegionAction::Stop); // Stop overrides pending Edit.
    [controls.edit mouseDown:down]; [controls.edit mouseUp:up];
    assert(events->action.load() == RegionAction::Stop); // Edit cannot displace Stop.
}

int main() {
    const char *enabled = std::getenv("SAUCE_OBS_OVERLAY_METADATA_TEST");
    if (!enabled || std::string_view(enabled) != "1") {
        std::puts("SKIP owned overlay controls: opt in with SAUCE_OBS_OVERLAY_METADATA_TEST=1 in a WindowServer session.");
        return 0;
    }
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        const auto first = std::make_shared<OverlayEvents>();
        const auto second = std::make_shared<OverlayEvents>();
        const auto controls = makeControlBar(152, 32, first);
        const auto other = makeControlBar(152, 32, second);
        SBRegionPanel *panel = makePanel(false);
        SBRegionPanel *otherPanel = makePanel(false);
        [panel setContentSize:NSMakeSize(152, 32)]; [otherPanel setContentSize:NSMakeSize(152, 32)];
        panel.title = controlWindowTitle(5, {10, 20, 300, 200});
        otherPanel.title = controlWindowTitle(5, {30, 40, 300, 200});
        panel.contentView = controls.bar; otherPanel.contentView = other.bar;
        assert([panel.title isEqualToString:@"Sauce Bunny capture controls: display 5, area 300.0 by 200.0 at 10.0, 20.0"]);
        assert(![panel.title isEqualToString:otherPanel.title]);
        assert([panel.accessibilityTitle isEqualToString:panel.title]);
        assert(controls.edit.accessibilityChildren.count == 1 && controls.stop.accessibilityChildren.count == 1);
        NSCell *editAX = controls.edit.accessibilityChildren.firstObject;
        NSCell *stopAX = controls.stop.accessibilityChildren.firstObject;
        assert(editAX == controls.edit.cell && stopAX == controls.stop.cell);
        assert([editAX.accessibilityLabel isEqualToString:@"Edit captured region"]);
        assert([stopAX.accessibilityLabel isEqualToString:@"Stop capture"]);
        assert([editAX.accessibilityRole isEqualToString:NSAccessibilityButtonRole]);
        assert([stopAX.accessibilityRole isEqualToString:NSAccessibilityButtonRole]);
        assert(!editAX.accessibilityEnabled && stopAX.accessibilityEnabled);

        // Disabled Edit remains inert through both AppKit action paths.
        [editAX accessibilityPerformPress]; [controls.edit performClick:nil];
        assert(first->action.load() == RegionAction::None);
        controls.edit.enabled = YES;
        assert(editAX.accessibilityEnabled);
        [editAX accessibilityPerformPress];
        assert(first->action.exchange(RegionAction::None) == RegionAction::Edit);
        [controls.edit performClick:nil];
        assert(first->action.exchange(RegionAction::None) == RegionAction::Edit);
        assert(second->action.load() == RegionAction::None);

        [stopAX accessibilityPerformPress];
        assert(first->action.exchange(RegionAction::None) == RegionAction::Stop);
        [controls.stop performClick:nil];
        assert(first->action.load() == RegionAction::Stop);
        [controls.edit performClick:nil];
        assert(first->action.load() == RegionAction::Stop); // Edit cannot displace Stop.
        [other.stop performClick:nil];
        assert(second->action.exchange(RegionAction::None) == RegionAction::Stop);
        assert(first->action.load() == RegionAction::Stop); // The owners remain isolated.

        checkMouseActions(controls, first);
        assert(second->action.load() == RegionAction::None);
        checkMouseActions(other, second);
        assert(first->action.load() == RegionAction::Stop);

        assert(!panel.visible && !otherPanel.visible && !panel.keyWindow && !otherPanel.keyWindow);
        assert(!panel.canBecomeKeyWindow && !otherPanel.canBecomeKeyWindow);
        assert(!controls.edit.acceptsFirstResponder && !controls.stop.acceptsFirstResponder);
        assert(NSApp.activationPolicy == NSApplicationActivationPolicyProhibited);
        panel.contentView = nil; otherPanel.contentView = nil;
        [panel close]; [otherPanel close];
        std::puts("Owned hidden production capture controls expose named AX buttons and isolated Edit/Stop actions without capture.");
        std::puts("Direct owned-window mouse handlers passed inside/outside release, one-shot, disabled Edit and Stop-priority checks; no physical event delivery tested.");
    }
}
