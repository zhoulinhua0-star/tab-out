# Changelog

## Unreleased

- Added a 7-second Undo for domain and global bulk tab closes.
- Protected pinned, audible, active, and browser-detected captured tabs from bulk cleanup.
- Added open-tab matches to quick search, including keyboard selection and the existing Google/Bing fallback.
- Sorted domain cards by most recent tab use while keeping Homepages first.
- Removed automatic page-load entrance animations that caused full-frame flashing on new-tab open and refresh.

## 1.4.0 — Accessibility and motion

- Added Alt + Arrow keyboard reordering for shortcuts with live announcements.
- Added dialog semantics, focus trapping, Escape handling, and focus restoration.
- Added labels for icon-only tab actions.
- Added `prefers-reduced-motion` support while preserving the normal swoosh and confetti experience.
- Standardized Chrome and Edge on the original Warm Paper palette and removed the theme selector.

## 1.3.0 — Shortcut experience

- Replaced native HTML drag-and-drop with thresholded Pointer Events.
- Added a pointer-following drag card and live FLIP reflow for neighboring shortcuts.
- Persist shortcut order once, when the drag completes.
- Limited the collapsed shortcut grid to two rows and added a More / Show less tile.
- Added a visible options button while keeping right-click actions available.
- Added responsive shortcut sizing and one-line labels.

## 1.2.1 — Stability and correctness

- Changed tab closing to operate on exact tab IDs so domain groups cannot close unrelated homepage tabs.
- Resynchronized duplicate rows after closing or saving one copy.
- Fixed the shortcut removal Undo button.
- Fixed narrow layouts that could overflow because of a 600px minimum width.
- Added debounced live updates when browser tabs change.
- Escaped dynamic shortcut and tab text before rendering.
- Switched favicons to the browser-local Manifest V3 favicon API.
- Unified Chrome and Edge dashboard logic to prevent behavior drift.
