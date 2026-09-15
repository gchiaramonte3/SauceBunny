// SPDX-License-Identifier: GPL-2.0-or-later
#import <AppKit/AppKit.h>
#include "region-overlay.hpp"
#include "region-window-snapshot.hpp"
#include <atomic>
#include <unistd.h>

namespace {
struct OverlayEvents {
    std::atomic<sauce_obs::RegionAction> action{sauce_obs::RegionAction::None};
    std::atomic<bool> invalidated{false};
};
std::vector<sauce_obs::RegionDisplay> displaySnapshot() {
    std::vector<sauce_obs::RegionDisplay> result;
    for (NSScreen *screen in NSScreen.screens) {
        const auto id = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        const auto frame = screen.frame;
        result.push_back({id, {frame.origin.x, frame.origin.y, frame.size.width, frame.size.height},
                          screen.backingScaleFactor, CGDisplayRotation(id)});
    }
    if (!sauce_obs::validRegionDisplays(result)) result.clear();
    return result;
}
} // namespace

@interface SBRegionPanel : NSPanel
@end
@implementation SBRegionPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface SBRegionButton : NSButton
@property(nonatomic) BOOL pressed;
@end
@implementation SBRegionButton
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (BOOL)acceptsFirstResponder { return NO; }
- (BOOL)needsPanelToBecomeKey { return NO; }
// Do not enter NSButton's synchronous mouse-tracking loop. The helper must
// continue servicing native cancellation while the pointer is held down.
- (void)mouseDown:(NSEvent *)event {
    (void)event;
    self.pressed = self.enabled;
    [self highlight:self.pressed];
}
- (void)mouseDragged:(NSEvent *)event {
    [self highlight:self.pressed && NSPointInRect([self convertPoint:event.locationInWindow fromView:nil], self.bounds)];
}
- (void)mouseUp:(NSEvent *)event {
    const BOOL activate = self.pressed && self.enabled &&
        NSPointInRect([self convertPoint:event.locationInWindow fromView:nil], self.bounds);
    self.pressed = NO; [self highlight:NO];
    if (activate) [self sendAction:self.action to:self.target];
}
@end

@interface SBRegionBorder : NSView
@property(nonatomic) BOOL live;
@end
@implementation SBRegionBorder
- (BOOL)isOpaque { return NO; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [(self.live ? NSColor.systemGreenColor : NSColor.secondaryLabelColor) setStroke];
    NSBezierPath *path = [NSBezierPath bezierPathWithRect:NSInsetRect(self.bounds, 1, 1)];
    path.lineWidth = 2; [path stroke];
}
@end

@interface SBRegionBar : NSView
@end
@implementation SBRegionBar
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [NSColor.windowBackgroundColor setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:5 yRadius:5] fill];
}
@end

@interface SBRegionActions : NSObject {
@public
    std::shared_ptr<OverlayEvents> events;
}
- (void)edit:(id)sender;
- (void)stop:(id)sender;
@end
@implementation SBRegionActions
- (void)edit:(id)sender {
    (void)sender;
    auto expected = sauce_obs::RegionAction::None;
    events->action.compare_exchange_strong(expected, sauce_obs::RegionAction::Edit);
}
- (void)stop:(id)sender { (void)sender; events->action.store(sauce_obs::RegionAction::Stop); }
@end

namespace sauce_obs {
namespace {
NSString *controlWindowTitle(uint32_t display, RegionRect crop) {
    return [NSString stringWithFormat:@"Sauce Bunny capture controls: display %u, area %.1f by %.1f at %.1f, %.1f",
        display, crop.width, crop.height, crop.x, crop.y];
}
struct RegionControls {
    SBRegionBar *__strong bar;
    SBRegionActions *__strong actions;
    SBRegionButton *__strong edit;
    SBRegionButton *__strong stop;
};
RegionControls makeControlBar(double width, double height, const std::shared_ptr<OverlayEvents> &events) {
    RegionControls controls;
    controls.bar = [[SBRegionBar alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
    controls.actions = [SBRegionActions new]; controls.actions->events = events;
    controls.edit = [[SBRegionButton alloc] initWithFrame:NSMakeRect(4, 2, width / 2 - 6, 28)];
    controls.edit.title = @"Edit"; controls.edit.target = controls.actions; controls.edit.action = @selector(edit:);
    // These cell-backed buttons expose the cell as their actionable AX child.
    controls.edit.cell.accessibilityLabel = @"Edit captured region";
    controls.edit.bordered = NO; controls.edit.enabled = NO;
    controls.stop = [[SBRegionButton alloc] initWithFrame:NSMakeRect(width / 2 + 2, 2, width / 2 - 6, 28)];
    controls.stop.title = @"Stop"; controls.stop.target = controls.actions; controls.stop.action = @selector(stop:);
    controls.stop.cell.accessibilityLabel = @"Stop capture"; controls.stop.bordered = NO;
    [controls.bar addSubview:controls.edit]; [controls.bar addSubview:controls.stop];
    return controls;
}
SBRegionPanel *makePanel(bool border) {
    auto *panel = [[SBRegionPanel alloc] initWithContentRect:NSMakeRect(0, 0, 32, 32)
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    panel.opaque = NO; panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = NO; panel.hidesOnDeactivate = NO;
    panel.movable = NO; panel.movableByWindowBackground = NO;
    panel.ignoresMouseEvents = border;
    panel.level = NSFloatingWindowLevel;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
    panel.releasedWhenClosed = NO;
    panel.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    return panel;
}
struct OverlayPool {
    SBRegionPanel *__strong border[2];
    SBRegionPanel *__strong controls[2];
    std::optional<RegionRegistry> registry;
};
// Stable window identities are shared, not lease state. In particular, releasing
// candidate B cannot remove/change an ID already excluded by published source A.
std::shared_ptr<OverlayPool> poolForHelper(std::string &error) {
    static std::shared_ptr<OverlayPool> pool;
    if (pool) return pool;
    if (![NSThread isMainThread]) { error = "overlay_wrong_thread"; return nullptr; }
    [NSApplication sharedApplication];
    if (![NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]) {
        // Preserve the existing rejection. Diagnose whether AppKit already
        // had the desired policy before considering any behavior change.
        error = NSApp.activationPolicy == NSApplicationActivationPolicyAccessory
            ? "overlay_activation_already_accessory" : "overlay_activation_rejected";
        return nullptr;
    }
    auto created = std::make_shared<OverlayPool>();
    std::array<uint32_t, 4> ids{};
    for (unsigned slot = 0; slot < 2; ++slot) {
        created->border[slot] = makePanel(true);
        created->controls[slot] = makePanel(false);
        const auto border = created->border[slot].windowNumber;
        const auto controls = created->controls[slot].windowNumber;
        if (border <= 0 || controls <= 0 || border > UINT32_MAX || controls > UINT32_MAX) {
            error = "overlay_window_ids_unavailable"; return nullptr;
        }
        ids[slot * 2] = static_cast<uint32_t>(border);
        ids[slot * 2 + 1] = static_cast<uint32_t>(controls);
    }
    created->registry = RegionRegistry::make(ids);
    if (!created->registry) { error = "overlay_registry_unavailable"; return nullptr; }
    pool = created; return pool;
}
} // namespace

struct RegionOverlay::Impl {
    unsigned slot;
    uint64_t attempt;
    std::shared_ptr<OverlayPool> pool;
    std::shared_ptr<OverlayEvents> events = std::make_shared<OverlayEvents>();
    std::vector<RegionDisplay> displays;
    std::vector<uint32_t> ids;
    SBRegionBorder *__strong view;
    SBRegionActions *__strong actions;
    SBRegionButton *__strong edit;
    id __strong observer;
    bool closed = false;
};

RegionOverlay::RegionOverlay(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
std::unique_ptr<RegionOverlay> RegionOverlay::create(unsigned slot, uint64_t attempt, uint32_t display,
        RegionRect crop, std::string &error) {
    error = "invalid_region";
    if (slot >= 2 || !attempt || !display || !validRegionRect(crop)) return nullptr;
    if (![NSThread isMainThread]) { error = "overlay_wrong_thread"; return nullptr; }
    auto screens = displaySnapshot();
    const auto found = std::find_if(screens.begin(), screens.end(), [display](auto screen) { return screen.id == display; });
    if (found == screens.end()) { error = "display_unavailable"; return nullptr; }
    const auto frame = placeRegion(found->frame, crop);
    if (!frame) return nullptr;
    auto pool = poolForHelper(error);
    if (!pool) return nullptr;
    if (!pool->registry->acquire(slot, attempt)) { error = "overlay_slot_busy_or_stale"; return nullptr; }
    auto impl = std::make_unique<Impl>();
    impl->slot = slot; impl->attempt = attempt; impl->pool = pool; impl->displays = screens;
    impl->ids = pool->registry->exclusions(slot, attempt);
    auto owner = std::unique_ptr<RegionOverlay>(new RegionOverlay(std::move(impl)));
    auto &state = *owner->impl_;
    state.view = [[SBRegionBorder alloc] initWithFrame:NSMakeRect(0, 0, frame->width, frame->height)];
    pool->border[slot].contentView = state.view;
    [pool->border[slot] setFrame:NSMakeRect(frame->x, frame->y, frame->width, frame->height) display:NO];
    const auto screen = found->frame;
    const double barWidth = std::min(152.0, screen.width), barHeight = std::min(32.0, screen.height);
    const double barX = std::clamp(frame->x + frame->width - barWidth, screen.x, screen.x + screen.width - barWidth);
    const double barY = std::clamp(frame->y + frame->height + 4, screen.y, screen.y + screen.height - barHeight);
    const auto controls = makeControlBar(barWidth, barHeight, state.events);
    state.actions = controls.actions; state.edit = controls.edit;
    pool->controls[slot].title = controlWindowTitle(display, crop);
    pool->controls[slot].contentView = controls.bar;
    [pool->controls[slot] setFrame:NSMakeRect(barX, barY, barWidth, barHeight) display:NO];
    auto events = state.events;
    state.observer = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification
        object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *) { events->invalidated.store(true); }];
    [pool->border[slot] orderFrontRegardless]; [pool->controls[slot] orderFrontRegardless];
    if (!owner->valid(attempt)) { error = "overlay_identity_unavailable"; return nullptr; }
    error.clear(); return owner;
}

RegionOverlay::~RegionOverlay() {
    if (!impl_ || impl_->closed) return;
    if ([NSThread isMainThread]) { close(impl_->attempt); return; }
    // This fallback is not a synchronous cleanup acknowledgement. The service
    // owns normal destruction on the AppKit thread and must call close there.
    auto pool = impl_->pool;
    const auto slot = impl_->slot;
    const auto attempt = impl_->attempt;
    SBRegionActions *actions = impl_->actions;
    [NSNotificationCenter.defaultCenter removeObserver:impl_->observer];
    dispatch_async(dispatch_get_main_queue(), ^{
        // NSControl does not own its target. Keep it alive until the views are
        // detached, even on this unsupported-thread destruction fallback.
        (void)actions;
        if (pool->registry->release(slot, attempt)) {
            [pool->border[slot] orderOut:nil]; [pool->controls[slot] orderOut:nil];
            pool->border[slot].contentView = nil; pool->controls[slot].contentView = nil;
        }
    });
}
int32_t RegionOverlay::ownerPid() const { return getpid(); }
const std::vector<uint32_t> &RegionOverlay::windowIds() const { return impl_->ids; }
bool RegionOverlay::valid(uint64_t attempt) const {
    return [NSThread isMainThread] && !impl_->closed && impl_->pool->registry->owns(impl_->slot, attempt) &&
        !impl_->events->invalidated.load() && sameRegionDisplays(impl_->displays, displaySnapshot()) &&
        exactRegionWindows(impl_->ids, ownerPid(), regionWindowSnapshot(impl_->ids));
}
bool RegionOverlay::markLive(uint64_t attempt) {
    if (!valid(attempt)) return false;
    impl_->view.live = YES; impl_->view.needsDisplay = YES; impl_->edit.enabled = YES; return true;
}
RegionAction RegionOverlay::poll(uint64_t attempt) {
    if (![NSThread isMainThread] || impl_->closed || !impl_->pool->registry->owns(impl_->slot, attempt)) return RegionAction::None;
    for (unsigned i = 0; i < 16; ++i) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (!event) break;
        [NSApp sendEvent:event];
    }
    // This helper owns the event loop instead of NSApplication.run. Perform
    // its normal window-update phase even when only capture readiness changed.
    [NSApp updateWindows];
    if (!valid(attempt)) return RegionAction::Invalidated;
    return impl_->events->action.exchange(RegionAction::None);
}
bool RegionOverlay::close(uint64_t attempt) {
    if (![NSThread isMainThread] || impl_->closed || !impl_->pool->registry->release(impl_->slot, attempt)) return false;
    [NSNotificationCenter.defaultCenter removeObserver:impl_->observer]; impl_->observer = nil;
    [impl_->pool->border[impl_->slot] orderOut:nil]; [impl_->pool->controls[impl_->slot] orderOut:nil];
    impl_->pool->border[impl_->slot].contentView = nil; impl_->pool->controls[impl_->slot].contentView = nil;
    impl_->closed = true; return true;
}
} // namespace sauce_obs
