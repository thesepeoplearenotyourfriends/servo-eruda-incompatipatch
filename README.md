```javascript
/*
 * Severin Incompatipatch — self-booting Eruda host
 * v0.2 + field addendums
 *
 * A page only needs:
 *   <script src="./incompatipatch-eruda.js"></script>
 *
 * This file turns a stock local Eruda bundle into a Servo/Severin-friendly
 * local dev console. It owns the complete lifecycle:
 *
 *   1. preflight
 *      - tests localStorage/sessionStorage
 *      - installs enumerable RAM Storage fallbacks only when opaque
 *        file: origins cause native storage to throw
 *
 *   2. load
 *      - dynamically loads CONFIG.eruda_source
 *      - starts Eruda with configured theme and display size
 *      - keeps the page-side installation to one script tag
 *
 *   3. postflight
 *      - repairs Eruda's unsupported `pointer-events: all` usage
 *      - watches later-created Eruda UI with MutationObserver
 *      - installs control and console compatibility addendums
 *
 * Included incompatipatches
 * ------------------------
 *
 * IP-001 — native control fallbacks
 *   - replaces dead <input type="range"> behavior with a custom DOM slider
 *   - supports click, drag, keyboard stepping, Home/End, PageUp/PageDown
 *   - writes back to the original input and emits normal input/change events
 *   - replaces dead single-select popups with a custom DOM listbox
 *   - preserves the original select.value / selectedIndex contract
 *   - dispatches normal input/change events for existing Eruda listeners
 *   - opens select menus upward when lower viewport space is insufficient
 *   - optionally marks patched controls with red diagnostic outlines
 *
 * IP-002 — console execution ergonomics
 *   - Ctrl+Enter / Cmd+Enter triggers Eruda's real Execute path
 *   - avoids dependence on Eruda's hidden/broken native action rail
 *
 * IP-003 — Storage inspector bridge
 *   - works around Eruda Resources using JSON.stringify(storage)
 *   - enumerates native Servo Storage honestly through:
 *       storage.length → storage.key(i) → storage.getItem(key)
 *   - makes ordinary app keys visible in Resources / Local Storage
 *   - can optionally reveal Eruda's own hidden eruda-* settings keys
 *
 * IP-004 — console history and completion
 *   - ArrowUp / ArrowDown session command history at textarea edges
 *   - preserves ordinary multiline arrow behavior away from those edges
 *   - Tab completion for safe identifier/property chains
 *   - Shift+Tab cycles candidates backward
 *   - completion avoids eval: no calls, operators, bracket expressions,
 *     or arbitrary source execution
 *
 * IP-005 — selected-log copy shortcut
 *   - Ctrl+C / Cmd+C activates Eruda's enabled Copy control when a
 *     structured console log is selected
 *   - never steals normal copy from textarea, input, contenteditable,
 *     or an ordinary document text selection
 *
 * IP-006 — legacy copy to modern clipboard bridge
 *   - Eruda/Licia uses document.execCommand("copy")
 *   - Servo reports legacy copy unsupported even though modern Clipboard API
 *     exists and navigator.clipboard.writeText() works
 *   - intercepts legacy copy only
 *   - reads Eruda/Licia's temporary offscreen copy textarea
 *   - routes its actual text through navigator.clipboard.writeText()
 *   - restores working toolbar Copy and selected-log Ctrl+C copying
 *
 * Known engine gaps still visible
 * -------------------------------
 *
 *   - CSS user-select is unsupported, so ordinary mouse drag selection in
 *     rendered console text remains an engine issue.
 *   - text-overflow, resize, appearance, forced-colors and related CSS
 *     declarations may be ignored by current Servo builds.
 *   - native <select> and <input type="range"> behavior is supplied here
 *     as a temporary JavaScript prosthetic, not considered permanently fixed.
 *   - Eruda's Network tab has little purpose in Severin's local/no-network
 *     runtime model.
 *   - malformed table-like HTML may trigger html5ever's current
 *     "foster parenting not implemented" warning.
 *
 */
 ```
