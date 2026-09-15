//! Pure policy for the desktop-region overlay foundation; no native windows,
//! capture APIs, IPC commands, or permission checks run here. A future native
//! owner must hold its panels alive, obtain fresh OS observations, and actually
//! install the returned exclusions before sharing any frames. Passing these
//! checks alone is not evidence that an overlay is excluded from capture.
//!
//! This deliberately remains unwired until that owner exists. Keep the policy
//! testable without introducing placeholder production behavior.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::BTreeMap;

// Match CapturePolicy.swift::captureCrop: dimensions must EXCEED 16 points.
const MIN_REGION_POINTS: f64 = 16.0;
const MAX_OVERLAY_WINDOWS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PointRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PointRect {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
            && (self.x + self.width).is_finite()
            && (self.y + self.height).is_finite()
            && self.x + self.width > self.x
            && self.y + self.height > self.y
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DisplayGeometry {
    /// Exact CGDirectDisplayID, not an enumeration index or the main screen.
    pub id: u32,
    /// Full NSScreen.frame: global AppKit points, with a bottom-left origin,
    /// already oriented by the OS. Not visibleFrame or CGDisplayBounds.
    pub appkit_frame: PointRect,
    /// Identity/invalidation inputs only. Neither scales the point-space crop.
    pub backing_scale: f64,
    pub rotation_degrees: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyError {
    InvalidTopology,
    InvalidAttempt,
    MissingDisplay,
    InvalidRegion,
    StaleAttempt,
    TopologyChanged,
    InvalidOwnership,
    MissingWindow,
    AmbiguousWindow,
    WindowOwnerChanged,
}

/// A fresh native snapshot. The owner must advance `revision` on every display
/// reconfiguration notification, even when a disconnect/reconnect restores the
/// same geometry. Enumeration order is irrelevant; duplicate IDs are invalid.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DisplayTopology {
    revision: u64,
    displays: BTreeMap<u32, DisplayGeometry>,
}

impl DisplayTopology {
    pub(crate) fn new(revision: u64, displays: &[DisplayGeometry]) -> Result<Self, PolicyError> {
        if revision == 0 || displays.is_empty() {
            return Err(PolicyError::InvalidTopology);
        }
        let mut by_id = BTreeMap::new();
        for display in displays {
            if display.id == 0
                || !display.appkit_frame.valid()
                || !display.backing_scale.is_finite()
                || display.backing_scale <= 0.0
                || !display.rotation_degrees.is_finite()
                || !(0.0..360.0).contains(&display.rotation_degrees)
                || by_id.insert(display.id, *display).is_some()
            {
                return Err(PolicyError::InvalidTopology);
            }
        }
        Ok(Self { revision, displays: by_id })
    }
}

/// Immutable consent geometry for ONE native attempt. The owner supplies a
/// nonzero, never-reused attempt ID and never reconstructs this from a stale
/// renderer callback. Any topology change requires fresh explicit selection.
#[derive(Debug)]
pub(crate) struct RegionSnapshot {
    attempt: u64,
    topology: DisplayTopology,
    frame: PointRect,
}

impl RegionSnapshot {
    /// `region` is top-left, display-local logical points (SC sourceRect), not
    /// thumbnail pixels or the encoded output raster. It is never rounded,
    /// clamped, multiplied by backing scale, or mapped to a fallback display.
    pub(crate) fn new(
        attempt: u64,
        display_id: u32,
        region: PointRect,
        topology: &DisplayTopology,
    ) -> Result<Self, PolicyError> {
        if attempt == 0 {
            return Err(PolicyError::InvalidAttempt);
        }
        let display = topology.displays.get(&display_id).ok_or(PolicyError::MissingDisplay)?;
        let screen = display.appkit_frame;
        if !region.valid()
            || region.x < 0.0
            || region.y < 0.0
            || region.width <= MIN_REGION_POINTS
            || region.height <= MIN_REGION_POINTS
            || region.x > screen.width
            || region.y > screen.height
            || region.width > screen.width - region.x
            || region.height > screen.height - region.y
        {
            return Err(PolicyError::InvalidRegion);
        }
        let frame = PointRect {
            x: screen.x + region.x,
            y: screen.y + (screen.height - region.y - region.height),
            width: region.width,
            height: region.height,
        };
        if !frame.valid() {
            return Err(PolicyError::InvalidRegion);
        }
        Ok(Self { attempt, topology: topology.clone(), frame })
    }

    /// Revalidate before using the frame for display/edit. The result is an
    /// AppKit global bottom-left rect; this does not create or position a panel.
    pub(crate) fn placement(
        &self,
        attempt: u64,
        current: &DisplayTopology,
    ) -> Result<PointRect, PolicyError> {
        if attempt != self.attempt {
            return Err(PolicyError::StaleAttempt);
        }
        if *current != self.topology {
            return Err(PolicyError::TopologyChanged);
        }
        Ok(self.frame)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WindowIdentity {
    pub id: u32,
    pub owner_pid: i32,
}

/// Only IDs returned by the native owner's actual panel creation belong here;
/// never accept renderer-supplied IDs or infer all windows from an app/PID. The
/// owner must keep those panels alive so an OS window ID cannot be recycled.
#[derive(Debug)]
pub(crate) struct OwnedOverlayWindows {
    attempt: u64,
    owner_pid: i32,
    ids: Vec<u32>,
}

impl OwnedOverlayWindows {
    pub(crate) fn new(attempt: u64, owner_pid: i32, ids: &[u32]) -> Result<Self, PolicyError> {
        if attempt == 0 {
            return Err(PolicyError::InvalidAttempt);
        }
        if owner_pid <= 0 || ids.is_empty() || ids.len() > MAX_OVERLAY_WINDOWS || ids.contains(&0) {
            return Err(PolicyError::InvalidOwnership);
        }
        let mut ids = ids.to_vec();
        ids.sort_unstable();
        if ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(PolicyError::InvalidOwnership);
        }
        Ok(Self { attempt, owner_pid, ids })
    }

    /// Validate a fresh SCShareableContent snapshot and return exactly the
    /// registered IDs for SCContentFilter(display:excludingWindows:). Missing,
    /// ambiguous or reassigned windows are terminal, not an empty-filter fallback.
    pub(crate) fn exclusions(
        &self,
        attempt: u64,
        observed: &[WindowIdentity],
    ) -> Result<Vec<u32>, PolicyError> {
        if attempt != self.attempt {
            return Err(PolicyError::StaleAttempt);
        }
        for id in &self.ids {
            let mut matches = observed.iter().filter(|window| window.id == *id);
            let window = matches.next().ok_or(PolicyError::MissingWindow)?;
            if matches.next().is_some() {
                return Err(PolicyError::AmbiguousWindow);
            }
            if window.owner_pid != self.owner_pid {
                return Err(PolicyError::WindowOwnerChanged);
            }
        }
        Ok(self.ids.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> PointRect {
        PointRect { x, y, width, height }
    }

    fn display(id: u32, frame: PointRect, scale: f64) -> DisplayGeometry {
        DisplayGeometry { id, appkit_frame: frame, backing_scale: scale, rotation_degrees: 0.0 }
    }

    fn screens() -> Vec<DisplayGeometry> {
        vec![
            display(7, rect(0.0, 0.0, 1440.0, 900.0), 2.0),
            display(31, rect(-1920.0, -180.0, 1920.0, 1080.0), 1.0),
            DisplayGeometry {
                rotation_degrees: 90.0,
                ..display(55, rect(300.0, 900.0, 1080.0, 1920.0), 2.0)
            },
        ]
    }

    fn topology() -> DisplayTopology {
        DisplayTopology::new(1, &screens()).unwrap()
    }

    #[test]
    fn maps_exact_display_local_points_with_vertical_flip() {
        let topology = topology();
        let selection = RegionSnapshot::new(91, 7, rect(100.25, 50.5, 640.5, 360.25), &topology).unwrap();
        assert_eq!(selection.placement(91, &topology), Ok(rect(100.25, 489.25, 640.5, 360.25)));
    }

    #[test]
    fn negative_origin_and_mixed_scale_do_not_change_crop_size() {
        let topology = topology();
        let crop = rect(100.0, 50.0, 640.0, 360.0);
        for (id, expected) in [
            (7, rect(100.0, 490.0, 640.0, 360.0)),
            (31, rect(-1820.0, 490.0, 640.0, 360.0)),
            (55, rect(400.0, 2410.0, 640.0, 360.0)),
        ] {
            let selection = RegionSnapshot::new(91, id, crop, &topology).unwrap();
            assert_eq!(selection.placement(91, &topology), Ok(expected));
        }
    }

    #[test]
    fn full_display_and_exact_bottom_right_edge_are_preserved() {
        let topology = topology();
        for (crop, expected) in [
            (rect(0.0, 0.0, 1920.0, 1080.0), rect(-1920.0, -180.0, 1920.0, 1080.0)),
            (rect(1800.0, 1000.0, 120.0, 80.0), rect(-120.0, -180.0, 120.0, 80.0)),
        ] {
            let selection = RegionSnapshot::new(91, 31, crop, &topology).unwrap();
            assert_eq!(selection.placement(91, &topology), Ok(expected));
        }
    }

    #[test]
    fn rejects_missing_display_and_zero_or_stale_attempt() {
        let topology = topology();
        let crop = rect(0.0, 0.0, 100.0, 100.0);
        assert_eq!(RegionSnapshot::new(0, 7, crop, &topology).unwrap_err(), PolicyError::InvalidAttempt);
        for id in [0, 1, 56] {
            assert_eq!(RegionSnapshot::new(91, id, crop, &topology).unwrap_err(), PolicyError::MissingDisplay);
        }
        let selection = RegionSnapshot::new(91, 7, crop, &topology).unwrap();
        for attempt in [0, 90, 92] {
            assert_eq!(selection.placement(attempt, &topology), Err(PolicyError::StaleAttempt));
        }
    }

    #[test]
    fn rejects_nonfinite_crop_in_every_field() {
        let topology = topology();
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for crop in [rect(bad, 0.0, 100.0, 100.0), rect(0.0, bad, 100.0, 100.0),
                rect(0.0, 0.0, bad, 100.0), rect(0.0, 0.0, 100.0, bad)] {
                assert_eq!(RegionSnapshot::new(91, 7, crop, &topology).unwrap_err(), PolicyError::InvalidRegion);
            }
        }
    }

    #[test]
    fn rejects_minimum_size_and_out_of_bounds_without_clamping() {
        let topology = topology();
        for crop in [
            rect(-0.01, 0.0, 100.0, 100.0), rect(0.0, -0.01, 100.0, 100.0),
            rect(0.0, 0.0, 16.0, 100.0), rect(0.0, 0.0, 100.0, 16.0),
            rect(0.0, 0.0, 0.0, 100.0), rect(0.0, 0.0, 100.0, -1.0),
            rect(1340.01, 0.0, 100.0, 100.0), rect(0.0, 800.01, 100.0, 100.0),
            rect(0.0, 0.0, 1440.01, 900.0), rect(0.0, 0.0, 1440.0, 900.01),
            rect(f64::MAX, 0.0, f64::MAX, 100.0),
        ] {
            assert_eq!(RegionSnapshot::new(91, 7, crop, &topology).unwrap_err(), PolicyError::InvalidRegion);
        }
        assert!(RegionSnapshot::new(91, 7, rect(0.0, 0.0, 16.01, 16.01), &topology).is_ok());
    }

    #[test]
    fn one_ulp_outside_display_is_not_tolerated_or_rounded_back_in() {
        let topology = topology();
        let beyond_width = f64::from_bits(120.0_f64.to_bits() + 1);
        let beyond_height = f64::from_bits(80.0_f64.to_bits() + 1);
        for crop in [
            rect(1800.0, 1000.0, beyond_width, 80.0),
            rect(1800.0, 1000.0, 120.0, beyond_height),
        ] {
            assert_eq!(
                RegionSnapshot::new(91, 31, crop, &topology).unwrap_err(),
                PolicyError::InvalidRegion,
            );
        }
    }

    #[test]
    fn enumeration_reordering_is_not_a_topology_change() {
        let topology = topology();
        let selection = RegionSnapshot::new(91, 31, rect(0.0, 0.0, 100.0, 100.0), &topology).unwrap();
        let mut reordered = screens();
        reordered.reverse();
        let current = DisplayTopology::new(1, &reordered).unwrap();
        assert_eq!(selection.placement(91, &current), selection.placement(91, &topology));
    }

    #[test]
    fn topology_revision_catches_same_geometry_disconnect_reconnect() {
        let topology = topology();
        let selection = RegionSnapshot::new(91, 7, rect(0.0, 0.0, 100.0, 100.0), &topology).unwrap();
        assert_eq!(selection.placement(91, &DisplayTopology::new(2, &screens()).unwrap()), Err(PolicyError::TopologyChanged));
    }

    #[test]
    fn any_geometry_identity_scale_rotation_or_display_set_change_invalidates() {
        let topology = topology();
        let selection = RegionSnapshot::new(91, 7, rect(0.0, 0.0, 100.0, 100.0), &topology).unwrap();
        for change in 0..10 {
            let mut current = screens();
            match change {
                0 => current[0].id = 8,
                1 => current[0].appkit_frame.x += 1.0,
                2 => current[0].appkit_frame.y += 1.0,
                3 => current[0].appkit_frame.width += 1.0,
                4 => current[0].appkit_frame.height += 1.0,
                5 => current[0].backing_scale = 1.0,
                6 => current[0].rotation_degrees = 90.0,
                7 => { current.remove(0); },
                8 => current.push(display(88, rect(1440.0, 0.0, 800.0, 600.0), 1.0)),
                // Also reject stale content when a caller failed to advance the revision.
                _ => current[1].appkit_frame.x -= 1.0,
            }
            assert_eq!(selection.placement(91, &DisplayTopology::new(1, &current).unwrap()), Err(PolicyError::TopologyChanged));
        }
    }

    #[test]
    fn invalid_topology_is_not_an_empty_or_main_screen_fallback() {
        assert_eq!(DisplayTopology::new(0, &screens()).unwrap_err(), PolicyError::InvalidTopology);
        assert_eq!(DisplayTopology::new(1, &[]).unwrap_err(), PolicyError::InvalidTopology);
        let good = screens()[0];
        assert_eq!(DisplayTopology::new(1, &[good, good]).unwrap_err(), PolicyError::InvalidTopology);
        for bad in [
            DisplayGeometry { id: 0, ..good },
            DisplayGeometry { backing_scale: 0.0, ..good },
            DisplayGeometry { backing_scale: f64::INFINITY, ..good },
            DisplayGeometry { rotation_degrees: f64::NAN, ..good },
            DisplayGeometry { rotation_degrees: -90.0, ..good },
            DisplayGeometry { rotation_degrees: 360.0, ..good },
            DisplayGeometry { appkit_frame: rect(0.0, 0.0, -1.0, 900.0), ..good },
            DisplayGeometry { appkit_frame: rect(0.0, f64::NAN, 1440.0, 900.0), ..good },
            DisplayGeometry { appkit_frame: rect(f64::MAX, 0.0, f64::MAX, 900.0), ..good },
            DisplayGeometry { appkit_frame: rect(f64::MAX, 0.0, 100.0, 900.0), ..good },
        ] {
            assert_eq!(DisplayTopology::new(1, &[bad]).unwrap_err(), PolicyError::InvalidTopology);
        }
    }

    fn owned() -> OwnedOverlayWindows {
        OwnedOverlayWindows::new(91, 123, &[22, 11]).unwrap()
    }

    fn observed() -> Vec<WindowIdentity> {
        vec![WindowIdentity { id: 11, owner_pid: 123 }, WindowIdentity { id: 22, owner_pid: 123 }]
    }

    #[test]
    fn exclusions_are_exact_owned_windows_not_all_windows_of_the_app() {
        let mut inventory = observed();
        inventory.push(WindowIdentity { id: 33, owner_pid: 123 });
        inventory.push(WindowIdentity { id: 44, owner_pid: 456 });
        inventory.reverse();
        assert_eq!(owned().exclusions(91, &inventory), Ok(vec![11, 22]));
    }

    #[test]
    fn missing_one_or_all_windows_never_returns_partial_or_empty_exclusions() {
        assert_eq!(owned().exclusions(91, &[]), Err(PolicyError::MissingWindow));
        for index in 0..2 {
            let mut inventory = observed();
            inventory.remove(index);
            assert_eq!(owned().exclusions(91, &inventory), Err(PolicyError::MissingWindow));
        }
    }

    #[test]
    fn recycled_window_ids_or_ambiguous_inventory_fail_closed() {
        for index in 0..2 {
            let mut inventory = observed();
            for pid in [0, -1, 456] {
                inventory[index].owner_pid = pid;
                assert_eq!(owned().exclusions(91, &inventory), Err(PolicyError::WindowOwnerChanged));
            }
        }
        let mut inventory = observed();
        inventory.push(inventory[0]);
        assert_eq!(owned().exclusions(91, &inventory), Err(PolicyError::AmbiguousWindow));
        inventory[2].owner_pid = 456;
        assert_eq!(owned().exclusions(91, &inventory), Err(PolicyError::AmbiguousWindow));
        inventory.reverse();
        assert_eq!(owned().exclusions(91, &inventory), Err(PolicyError::AmbiguousWindow));
    }

    #[test]
    fn ownership_requires_bounded_distinct_nonzero_ids_and_positive_pid() {
        assert_eq!(OwnedOverlayWindows::new(0, 123, &[11]).unwrap_err(), PolicyError::InvalidAttempt);
        for pid in [0, -1] {
            assert_eq!(OwnedOverlayWindows::new(91, pid, &[11]).unwrap_err(), PolicyError::InvalidOwnership);
        }
        for ids in [vec![], vec![0], vec![11, 11], (1..=9).collect()] {
            assert_eq!(OwnedOverlayWindows::new(91, 123, &ids).unwrap_err(), PolicyError::InvalidOwnership);
        }
        assert!(OwnedOverlayWindows::new(91, 123, &(1..=8).collect::<Vec<_>>()).is_ok());
    }

    #[test]
    fn late_old_attempt_cannot_authorize_exclusions_for_the_replacement() {
        let previous = owned();
        let replacement = OwnedOverlayWindows::new(92, 123, &[33]).unwrap();
        let inventory = [WindowIdentity { id: 33, owner_pid: 123 }];
        assert_eq!(previous.exclusions(92, &observed()), Err(PolicyError::StaleAttempt));
        assert_eq!(previous.exclusions(0, &observed()), Err(PolicyError::StaleAttempt));
        assert_eq!(replacement.exclusions(91, &inventory), Err(PolicyError::StaleAttempt));
        assert_eq!(replacement.exclusions(92, &inventory), Ok(vec![33]));
    }
}
