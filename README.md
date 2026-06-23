```javascript
/*
 * Servo support bundle — Incompatipatch core + Eruda channel
 * v0.3 + field addendums
 *
 * A page still needs only:
 *   <script src="./incompatipatch-eruda.js"></script>
 *
 * This remains one file because a stock local Eruda is not presently useful
 * in Servo without its compatibility work. Internally, however, it is two
 * deliberately separate channels:
 *
 *   1. INCOMPATIPATCH CORE
 *      Generic document-runtime compatibility, meaningful even without Eruda.
 *      Today this is the opaque-file-origin Storage preflight.
 *
 *      Public surface:
 *        window.SevrinIncompatipatch
 *          .preflight()
 *          .storage
 *
 *   2. ERUDA CHANNEL
 *      Eruda loading, initialization, Eruda-only DOM/CSS prosthetics, and
 *      Eruda-specific addendums. It is the only channel allowed to know
 *      Eruda class names, internals, or quirks.
 *
 *      Public surface:
 *        window.SevrinEruda
 *          .config
 *          .boot()
 *          .refresh()
 *          .closeMenus()
 *
 * Boundary rule:
 *   Put a repair in Incompatipatch only when it describes Servo's document
 *   runtime independently of Eruda. Put a repair in the Eruda channel when
 *   it touches #eruda, window.eruda, Eruda/Licia behavior, or an Eruda-owned
 *   control. Do not make an Eruda defect look like a general engine feature.
 *
 * ERUDA CHANNEL CONTENTS
 * ----------------------
 *
 * ER-001 — native control fallbacks
 *   - replaces dead Eruda <input type="range"> behavior with a custom DOM
 *     slider, including click, drag, keyboard stepping, Home/End, and pages
 *   - replaces dead Eruda single-select popups with a custom DOM listbox
 *   - preserves input/select values and dispatches normal input/change events
 *   - opens select menus upward when lower viewport space is insufficient
 *
 * ER-002 — console execution ergonomics
 *   - Ctrl+Enter / Cmd+Enter triggers Eruda's real Execute path
 *
 * ER-003 — Storage inspector bridge
 *   - replaces Eruda Resources' broken Storage JSON enumeration with:
 *       storage.length → storage.key(i) → storage.getItem(key)
 *   - can optionally reveal Eruda's own hidden eruda-* settings keys
 *
 * ER-004 — console history and completion
 *   - ArrowUp / ArrowDown session command history at textarea edges
 *   - Tab completion for safe identifier/property chains, without eval
 *
 * ER-005 — selected-log copy shortcut
 *   - Ctrl+C / Cmd+C activates Eruda's enabled Copy control for a selected log
 *   - never steals normal copy from editable controls or real text selection
 *
 * ER-006 — legacy copy to modern clipboard bridge
 *   - routes Eruda/Licia's known temporary-copy payload through
 *     navigator.clipboard.writeText(), leaving unrelated page copy native
 *
 * Known engine gaps still visible
 * -------------------------------
 *
 *   - CSS user-select is unsupported, so ordinary mouse drag selection in
 *     rendered console text remains an engine issue.
 *   - text-overflow, resize, appearance, forced-colors and related CSS
 *     declarations may be ignored by current Servo builds.
 *   - native <select> and <input type="range"> behavior is supplied in the
 *     Eruda channel as a temporary JavaScript prosthetic.
 *   - Eruda's Network tab has little purpose in Servo's local/no-network
 *     runtime model.
 *   - malformed table-like HTML may trigger html5ever's current
 *     "foster parenting not implemented" warning.
 *
 */
 ```
