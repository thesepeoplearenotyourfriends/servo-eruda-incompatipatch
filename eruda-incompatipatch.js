
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

(function (global, document) {
  'use strict';

  if (global.SevrinIncompatipatch) return;

  /* ------------------------------------------------------------
   * CONFIG — edit this small block, not the machinery below.
   * ---------------------------------------------------------- */
  var CONFIG = {
    eruda_source: './eruda.js',
    theme: 'dark',
    display_size: '52',
    console_history_max: 150,
    console_tab_complete: true,
    console_completion_max: 9,
    bridge_eruda_storage: true,
    show_eruda_storage_entries: false,
    console_copy_shortcut: true,
    legacy_copy_bridge: true,

    /* Useful defaults for the current Servo / Servoshell setup. */
    use_shadow_dom: false,
    auto_scale: false,

    /* Red outline + tooltip on controls currently using a fallback. */
    debug_marks: true,

    /* Turn individual temporary repairs on or off. */
    patch_ranges: true,
    patch_selects: true,
    patch_ctrl_enter: true
  };

  var state = {
    config: CONFIG,
    booted: false,
    initialized: false,
    styleInstalled: false,
    observer: null,
    scanQueued: false,
    openMenu: null,
    patchedRanges: [],
    patchedSelects: [],
    storage: {
      local: null,
      session: null,
      localInstalled: false,
      sessionInstalled: false
    }
  };

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function setStyles(node, styles) {
    for (var key in styles) {
      if (own(styles, key)) node.style[key] = styles[key];
    }
    return node;
  }

  function make(tag, text, styles) {
    var node = document.createElement(tag);

    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }

    if (styles) setStyles(node, styles);

    return node;
  }

  function fire(node, type) {
    var event;

    try {
      event = new Event(type, { bubbles: true });
    } catch (error) {
      event = document.createEvent('Event');
      event.initEvent(type, true, false);
    }

    node.dispatchEvent(event);
  }

  function finite(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function decimalPlaces(value) {
    var text = String(value);
    var dot = text.indexOf('.');
    return dot === -1 ? 0 : text.length - dot - 1;
  }

  function roundTo(value, places) {
    var scale = Math.pow(10, Math.min(10, Math.max(0, places)));
    return Math.round(value * scale) / scale;
  }

  function debugMark(node, message) {
    if (!state.config.debug_marks) return;

    node.title = node.title
      ? node.title + '\n' + message
      : message;

    node.setAttribute('data-sevrin-incompatipatch', message);
    node.style.outline = '1px solid #ff7373';
    node.style.outlineOffset = '1px';
  }

  /* ------------------------------------------------------------
   * PREFLIGHT: enumerable in-memory Storage.
   *
   * Eruda's Resources pane runs JSON.stringify(storage), so a
   * closure-only map is invisible to it. This object mirrors each
   * key as an enumerable own property as well as supporting the
   * normal getItem/setItem/key/length surface.
   * ---------------------------------------------------------- */
  function makeEnumerableStorage() {
    var values = Object.create(null);
    var storage = Object.create(null);

    function isReserved(key) {
      return (
        key === 'getItem' ||
        key === 'setItem' ||
        key === 'removeItem' ||
        key === 'clear' ||
        key === 'key' ||
        key === 'length'
      );
    }

    function mirror(key, value) {
      if (isReserved(key)) return;

      Object.defineProperty(storage, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: value
      });
    }

    function unmirror(key) {
      if (!isReserved(key)) delete storage[key];
    }

    Object.defineProperties(storage, {
      length: {
        enumerable: false,
        configurable: false,
        get: function () {
          return Object.keys(values).length;
        }
      },

      key: {
        enumerable: false,
        configurable: false,
        value: function (index) {
          return Object.keys(values)[Number(index)] || null;
        }
      },

      getItem: {
        enumerable: false,
        configurable: false,
        value: function (key) {
          key = String(key);
          return own(values, key) ? values[key] : null;
        }
      },

      setItem: {
        enumerable: false,
        configurable: false,
        value: function (key, value) {
          key = String(key);
          value = String(value);

          values[key] = value;
          mirror(key, value);
        }
      },

      removeItem: {
        enumerable: false,
        configurable: false,
        value: function (key) {
          key = String(key);

          delete values[key];
          unmirror(key);
        }
      },

      clear: {
        enumerable: false,
        configurable: false,
        value: function () {
          var keys = Object.keys(values);

          for (var i = 0; i < keys.length; i++) {
            unmirror(keys[i]);
          }

          values = Object.create(null);
        }
      },

        toJSON: {
          enumerable: false,
          configurable: false,
          value: function () {
            var copy = {};
            var keys = Object.keys(values);

            for (var i = 0; i < keys.length; i++) {
              copy[keys[i]] = values[keys[i]];
            }

            return copy;
          }
        },

    });

    return storage;
  }

  function storageWorks(name) {
    try {
      var storage = global[name];
      var key = '__sevrin_storage_probe__' + Date.now();

      storage.setItem(key, '1');

      var ok = storage.getItem(key) === '1';

      storage.removeItem(key);

      return ok;
    } catch (error) {
      return false;
    }
  }

  function installStorageFallback(name) {
    if (storageWorks(name)) return false;

    var storage = makeEnumerableStorage();
    var installed = false;

    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: true,
        value: storage
      });

      installed = global[name] === storage;
    } catch (error) {
      try {
        global[name] = storage;
        installed = global[name] === storage;
      } catch (secondError) {
        installed = false;
      }
    }

    if (installed) {
      if (name === 'localStorage') {
        state.storage.local = storage;
        state.storage.localInstalled = true;
      } else {
        state.storage.session = storage;
        state.storage.sessionInstalled = true;
      }
    }

    return installed;
  }

  function preflight() {
    installStorageFallback('localStorage');
    installStorageFallback('sessionStorage');
  }

  /* ------------------------------------------------------------
   * LOADER + ERUDA INITIALIZATION.
   * ---------------------------------------------------------- */
  function normalizedTheme(theme) {
    theme = String(theme || 'dark').trim();

    if (!theme) return 'Dark';

    return theme.charAt(0).toUpperCase() + theme.slice(1);
  }

  function startEruda() {
    if (state.initialized) return;

    if (!global.eruda || typeof global.eruda.init !== 'function') {
      console.error(
        '[Incompatipatch] Eruda loaded but window.eruda.init is unavailable.'
      );
      return;
    }

    global.eruda.init({
      useShadowDom: !!state.config.use_shadow_dom,
      autoScale: !!state.config.auto_scale,

      defaults: {
        theme: normalizedTheme(state.config.theme),
        displaySize: String(state.config.display_size)
      }
    });

    state.initialized = true;
    postflight();
  }

  function loadEruda() {
    if (global.eruda && typeof global.eruda.init === 'function') {
      startEruda();
      return;
    }

    var script = document.createElement('script');

    script.src = state.config.eruda_source;
    script.async = false;

    script.setAttribute(
      'data-sevrin-eruda-source',
      state.config.eruda_source
    );

    script.onload = startEruda;

    script.onerror = function () {
      console.error(
        '[Incompatipatch] Could not load Eruda from:',
        state.config.eruda_source
      );
    };

    (document.head || document.documentElement).appendChild(script);
  }

  function boot() {
    if (state.booted) return;

    state.booted = true;

    preflight();
    loadEruda();
  }

  /* ------------------------------------------------------------
   * POSTFLIGHT: CSS and control prosthetics.
   * ---------------------------------------------------------- */
  function installErudaCssRepair() {
    if (state.styleInstalled) return;

    var style = document.createElement('style');

    style.setAttribute(
      'data-sevrin-incompatipatch-css',
      'true'
    );

    style.textContent = [
      '/* Servo rejects pointer-events: all; Eruda depends on it. */',
      '.eruda-container { pointer-events: none !important; }',
      '.eruda-container * { pointer-events: auto !important; }',
      '',
      '/* Keep fallback controls legible inside dark Eruda panels. */',
      '.sevrin-range-patch, .sevrin-select-patch {',
      '  font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;',
      '}'
    ].join('\n');

    (document.head || document.documentElement).appendChild(style);

    state.styleInstalled = true;
  }

  function hideOriginalControl(node) {
    node.setAttribute('data-sevrin-original-control', 'true');

    setStyles(node, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      minWidth: '1px',
      minHeight: '1px',
      opacity: '0',
      pointerEvents: 'none',
      margin: '0',
      padding: '0',
      borderWidth: '0',
      overflow: 'hidden'
    });

    node.tabIndex = -1;
  }

  function measuredBox(node, fallbackWidth, fallbackHeight) {
    var rect = node.getBoundingClientRect();

    var style = global.getComputedStyle
      ? global.getComputedStyle(node)
      : null;

    var width =
      rect.width ||
      (style && parseFloat(style.width)) ||
      fallbackWidth;

    var height =
      rect.height ||
      (style && parseFloat(style.height)) ||
      fallbackHeight;

    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    };
  }

  /* ------------------------------------------------------------
   * RANGE FALLBACK.
   * ---------------------------------------------------------- */
  function rangeSpec(input) {
    var min = finite(input.min, 0);
    var max = finite(input.max, 100);

    if (max < min) {
      var swap = min;
      min = max;
      max = swap;
    }

    var step =
      input.step === 'any'
        ? 0
        : finite(input.step, 1);

    if (step <= 0) step = 1;

    return {
      min: min,
      max: max,
      step: step,
      current: clamp(finite(input.value, min), min, max)
    };
  }

  function patchRange(input) {
    if (!input || input.disabled) return;

    if (
      input.getAttribute(
        'data-sevrin-range-patched'
      ) === 'true'
    ) {
      return;
    }

    input.setAttribute(
      'data-sevrin-range-patched',
      'true'
    );

    var box = measuredBox(input, 120, 20);

    var wrapper = make('span', null, {
      position: 'relative',
      display: 'inline-block',
      width: box.width + 'px',
      height: Math.max(box.height, 22) + 'px',
      boxSizing: 'border-box',
      verticalAlign: 'middle',
      cursor: 'ew-resize',
      pointerEvents: 'auto',
      userSelect: 'none'
    });

    wrapper.className = 'sevrin-range-patch';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'slider');

    var track = make('span', null, {
      position: 'absolute',
      left: '0',
      right: '0',
      top: '50%',
      height: '8px',
      marginTop: '-4px',
      boxSizing: 'border-box',
      border: '1px solid #4d5959',
      backgroundColor: '#101414',
      pointerEvents: 'auto'
    });

    var fill = make('span', null, {
      position: 'absolute',
      left: '0',
      top: '0',
      bottom: '0',
      width: '0%',
      backgroundColor: '#d9ff59',
      pointerEvents: 'none'
    });

    var thumb = make('span', null, {
      position: 'absolute',
      left: '0%',
      top: '50%',
      width: '14px',
      height: '14px',
      marginLeft: '-7px',
      marginTop: '-7px',
      boxSizing: 'border-box',
      border: '1px solid #edf9f9',
      backgroundColor: '#202828',
      pointerEvents: 'none'
    });

    track.appendChild(fill);
    track.appendChild(thumb);

    input.parentNode.insertBefore(wrapper, input);

    wrapper.appendChild(input);
    wrapper.appendChild(track);

    hideOriginalControl(input);

    var dragging = false;
    var changedDuringDrag = false;

    function sync() {
      var spec = rangeSpec(input);
      var span = spec.max - spec.min;

      var fraction = span
        ? (spec.current - spec.min) / span
        : 0;

      fraction = clamp(fraction, 0, 1);

      var percent = (fraction * 100).toFixed(4) + '%';

      fill.style.width = percent;
      thumb.style.left = percent;

      wrapper.setAttribute('aria-valuemin', String(spec.min));
      wrapper.setAttribute('aria-valuemax', String(spec.max));
      wrapper.setAttribute('aria-valuenow', String(spec.current));
    }

    function setValue(value, emitInput) {
      var spec = rangeSpec(input);
      var next = clamp(value, spec.min, spec.max);

      if (input.step !== 'any') {
        next =
          spec.min +
          Math.round((next - spec.min) / spec.step) *
            spec.step;
      }

      next = roundTo(
        next,
        Math.max(
          decimalPlaces(spec.step),
          decimalPlaces(spec.min)
        )
      );

      next = clamp(next, spec.min, spec.max);

      var before = String(input.value);

      input.value = String(next);

      sync();

      if (
        String(input.value) !== before &&
        emitInput
      ) {
        fire(input, 'input');
        return true;
      }

      return false;
    }

    function setFromPointer(event) {
      var rect = track.getBoundingClientRect();

      var x = finite(event.clientX, rect.left);

      var fraction = rect.width
        ? (x - rect.left) / rect.width
        : 0;

      var spec = rangeSpec(input);

      return setValue(
        spec.min +
          clamp(fraction, 0, 1) *
            (spec.max - spec.min),
        true
      );
    }

    wrapper.addEventListener('pointerdown', function (event) {
      dragging = true;

      changedDuringDrag = setFromPointer(event);

      wrapper.focus();

      try {
        wrapper.setPointerCapture(event.pointerId);
      } catch (error) {
        /*
         * Servo may not expose pointer capture yet.
         * The document-level pointer path below is enough.
         */
      }

      event.preventDefault();
    });

    document.addEventListener(
      'pointermove',
      function (event) {
        if (!dragging) return;

        changedDuringDrag =
          setFromPointer(event) || changedDuringDrag;

        event.preventDefault();
      },
      true
    );

    function endDrag(event) {
      if (!dragging) return;

      dragging = false;

      try {
        wrapper.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* Nothing to release is fine. */
      }

      if (changedDuringDrag) {
        fire(input, 'change');
      }

      changedDuringDrag = false;
    }

    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);

    wrapper.addEventListener('keydown', function (event) {
      var spec = rangeSpec(input);

      var page = Math.max(
        spec.step,
        (spec.max - spec.min) / 10
      );

      var next = spec.current;
      var handled = true;

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          next -= spec.step;
          break;

        case 'ArrowRight':
        case 'ArrowUp':
          next += spec.step;
          break;

        case 'PageDown':
          next -= page;
          break;

        case 'PageUp':
          next += page;
          break;

        case 'Home':
          next = spec.min;
          break;

        case 'End':
          next = spec.max;
          break;

        default:
          handled = false;
      }

      if (!handled) return;

      event.preventDefault();

      if (setValue(next, true)) {
        fire(input, 'change');
      }
    });

    input.addEventListener('input', sync);
    input.addEventListener('change', sync);

    wrapper.addEventListener('focus', function () {
      track.style.borderColor = '#d9ff59';
    });

    wrapper.addEventListener('blur', function () {
      track.style.borderColor = '#4d5959';
    });

    debugMark(
      wrapper,
      'Sevrin fallback: native range default action unavailable'
    );

    sync();

    state.patchedRanges.push({
      input: input,
      wrapper: wrapper,
      sync: sync
    });
  }

  /* ------------------------------------------------------------
   * SELECT FALLBACK.
   * ---------------------------------------------------------- */
  function closeOpenMenu() {
    if (!state.openMenu) return;

    state.openMenu.close();
    state.openMenu = null;
  }

  function patchSelect(select) {
    if (!select || select.disabled) return;

    if (
      select.getAttribute(
        'data-sevrin-select-patched'
      ) === 'true'
    ) {
      return;
    }

    if (select.multiple) {
      select.setAttribute(
        'data-sevrin-select-patched',
        'unsupported-multiple'
      );

      debugMark(
        select,
        'Sevrin warning: multi-select fallback not installed'
      );

      return;
    }

    select.setAttribute(
      'data-sevrin-select-patched',
      'true'
    );

    var box = measuredBox(select, 120, 24);

    var wrapper = make('span', null, {
      position: 'relative',
      display: 'inline-block',
      width: box.width + 'px',
      minWidth: '70px',
      height: Math.max(box.height, 24) + 'px',
      verticalAlign: 'middle',
      pointerEvents: 'auto'
    });

    wrapper.className = 'sevrin-select-patch';

    var button = make('button', '', {
      display: 'block',
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      padding: '3px 25px 3px 7px',
      border: '1px solid #4d5959',
      backgroundColor: '#171c1c',
      color: '#edf5f5',
      textAlign: 'left',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      pointerEvents: 'auto'
    });

    button.type = 'button';

    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    var arrow = make('span', '▾', {
      position: 'absolute',
      right: '8px',
      top: '50%',
      marginTop: '-9px',
      color: '#d9ff59',
      pointerEvents: 'none'
    });

    select.parentNode.insertBefore(wrapper, select);

    wrapper.appendChild(select);
    wrapper.appendChild(button);
    wrapper.appendChild(arrow);

    hideOriginalControl(select);

    function selectedOption() {
      return (
        select.options[select.selectedIndex] ||
        select.options[0] ||
        null
      );
    }

    function sync() {
      var option = selectedOption();

      button.textContent = option
        ? option.textContent
        : '(empty)';

      button.appendChild(arrow);

      button.setAttribute(
        'aria-label',
        option ? option.textContent : '(empty)'
      );

      button.disabled = !!select.disabled;
    }

    function choose(index, emit) {
      if (
        index < 0 ||
        index >= select.options.length ||
        select.options[index].disabled
      ) {
        return;
      }

      var before = select.selectedIndex;

      select.selectedIndex = index;

      sync();

      if (
        emit &&
        before !== select.selectedIndex
      ) {
        fire(select, 'input');
        fire(select, 'change');
      }
    }

    function openMenu() {
      if (select.disabled) return;

      if (
        state.openMenu &&
        state.openMenu.owner === select
      ) {
        closeOpenMenu();
        return;
      }

      closeOpenMenu();

      var rect = button.getBoundingClientRect();

      var wanted = Math.min(
        260,
        Math.max(32, select.options.length * 31)
      );

      var below = Math.max(
        0,
        global.innerHeight - rect.bottom - 6
      );

      var above = Math.max(0, rect.top - 6);

      var openUp =
        below < Math.min(wanted, 100) &&
        above > below;

      var height = Math.max(
        32,
        Math.min(
          wanted,
          openUp ? above : below
        )
      );

      var menu = make('div', null, {
        position: 'fixed',
        left: Math.round(rect.left) + 'px',
        top: openUp
          ? 'auto'
          : Math.round(rect.bottom + 2) + 'px',
        bottom: openUp
          ? Math.round(
              global.innerHeight - rect.top + 2
            ) + 'px'
          : 'auto',
        minWidth: Math.round(rect.width) + 'px',
        maxWidth: '80vw',
        height: Math.round(height) + 'px',
        overflowY: 'auto',
        boxSizing: 'border-box',
        border: '1px solid #738181',
        backgroundColor: '#111616',
        color: '#edf5f5',
        zIndex: '2147483647',
        pointerEvents: 'auto'
      });

      menu.setAttribute('role', 'listbox');

      var selectedItem = null;

      for (var i = 0; i < select.options.length; i++) {
        (function (index) {
          var option = select.options[index];

          var item = make('button', option.textContent, {
            display: 'block',
            width: '100%',
            minHeight: '30px',
            boxSizing: 'border-box',
            padding: '6px 8px',
            borderWidth: '0',
            borderBottom: '1px solid #2b3535',
            backgroundColor:
              index === select.selectedIndex
                ? '#293333'
                : '#111616',
            color: option.disabled
              ? '#718080'
              : '#edf5f5',
            textAlign: 'left',
            cursor: option.disabled
              ? 'default'
              : 'pointer',
            pointerEvents: 'auto'
          });

          item.type = 'button';
          item.disabled = option.disabled;

          item.setAttribute('role', 'option');

          item.setAttribute(
            'aria-selected',
            index === select.selectedIndex
              ? 'true'
              : 'false'
          );

          item.addEventListener('click', function () {
            choose(index, true);
            closeOpenMenu();
            button.focus();
          });

          if (index === select.selectedIndex) {
            selectedItem = item;
          }

          menu.appendChild(item);
        })(i);
      }

      document.body.appendChild(menu);

      button.setAttribute('aria-expanded', 'true');

      if (selectedItem) {
        selectedItem.scrollIntoView({
          block: 'nearest'
        });
      }

      function outside(event) {
        if (
          menu.contains(event.target) ||
          button.contains(event.target)
        ) {
          return;
        }

        close();
      }

      function close() {
        document.removeEventListener(
          'pointerdown',
          outside,
          true
        );

        if (menu.parentNode) {
          menu.parentNode.removeChild(menu);
        }

        button.setAttribute('aria-expanded', 'false');

        if (
          state.openMenu &&
          state.openMenu.owner === select
        ) {
          state.openMenu = null;
        }
      }

      state.openMenu = {
        owner: select,
        close: close
      };

      document.addEventListener(
        'pointerdown',
        outside,
        true
      );
    }

    button.addEventListener('click', openMenu);

    button.addEventListener('keydown', function (event) {
      var current = select.selectedIndex;
      var handled = true;

      switch (event.key) {
        case 'Enter':
        case ' ':
          openMenu();
          break;

        case 'ArrowDown':
          choose(
            Math.min(
              select.options.length - 1,
              current + 1
            ),
            true
          );
          break;

        case 'ArrowUp':
          choose(Math.max(0, current - 1), true);
          break;

        case 'Home':
          choose(0, true);
          break;

        case 'End':
          choose(select.options.length - 1, true);
          break;

        default:
          handled = false;
      }

      if (handled) event.preventDefault();
    });

    select.addEventListener('input', sync);
    select.addEventListener('change', sync);

    debugMark(
      wrapper,
      'Sevrin fallback: native select popup unavailable'
    );

    sync();

    state.patchedSelects.push({
      select: select,
      wrapper: wrapper,
      sync: sync
    });
  }

  /* ------------------------------------------------------------
   * CTRL+ENTER: use Eruda's own hidden Execute handler.
   * ---------------------------------------------------------- */
  function patchErudaCtrlEnter(root) {
    if (!state.config.patch_ctrl_enter) return;

    var textareas = candidates(
      root,
      '.eruda-js-input textarea'
    );

    for (var i = 0; i < textareas.length; i++) {
      var textarea = textareas[i];

      if (
        textarea.getAttribute(
          'data-sevrin-ctrl-enter'
        ) === 'true'
      ) {
        continue;
      }

      textarea.setAttribute(
        'data-sevrin-ctrl-enter',
        'true'
      );

      textarea.title = textarea.title
        ? textarea.title +
          '\nCtrl+Enter runs JavaScript.'
        : 'Ctrl+Enter runs JavaScript.';

      textarea.addEventListener(
        'keydown',
        function (event) {
          if (
            !(
              (event.ctrlKey || event.metaKey) &&
              event.key === 'Enter'
            )
          ) {
            return;
          }

          event.preventDefault();

          var host = this.closest
            ? this.closest('.eruda-js-input')
            : null;

          var execute = host
            ? host.querySelector('.eruda-execute')
            : null;

          if (execute) execute.click();
        }
      );
    }
  }

  function candidates(root, selector) {
    var result = [];

    if (!root) return result;

    if (
      root.nodeType === 1 &&
      root.matches &&
      root.matches(selector)
    ) {
      result.push(root);
    }

    if (root.querySelectorAll) {
      var found = root.querySelectorAll(selector);

      for (var i = 0; i < found.length; i++) {
        result.push(found[i]);
      }
    }

    return result;
  }

  function scan(root) {
    root = root || document;

    if (state.config.patch_ranges) {
      var ranges = candidates(
        root,
        'input[type="range"]'
      );

      for (var i = 0; i < ranges.length; i++) {
        patchRange(ranges[i]);
      }
    }

    if (state.config.patch_selects) {
      var selects = candidates(root, 'select');

      for (var j = 0; j < selects.length; j++) {
        patchSelect(selects[j]);
      }
    }

    patchErudaCtrlEnter(root);
  }

  function queueScan(root) {
    if (state.scanQueued) return;

    state.scanQueued = true;

    Promise.resolve().then(function () {
      state.scanQueued = false;
      scan(root || document);
    });
  }

  function observe() {
    if (state.observer) return;

    state.observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        for (
          var j = 0;
          j < records[i].addedNodes.length;
          j++
        ) {
          var node = records[i].addedNodes[j];

          if (node.nodeType === 1) {
            queueScan(node);
          }
        }
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function postflight() {
    installErudaCssRepair();
    scan(document);
    observe();

    console.info('[Incompatipatch] Eruda started.', {
      source: state.config.eruda_source,
      theme: state.config.theme,
      display_size: state.config.display_size,
      localStorageFallback: state.storage.localInstalled,
      sessionStorageFallback: state.storage.sessionInstalled
    });
  }

  global.SevrinIncompatipatch = {
    version: '0.2',
    config: CONFIG,
    boot: boot,

    refresh: function () {
      for (
        var i = 0;
        i < state.patchedRanges.length;
        i++
      ) {
        state.patchedRanges[i].sync();
      }

      for (
        var j = 0;
        j < state.patchedSelects.length;
        j++
      ) {
        state.patchedSelects[j].sync();
      }

      scan(document);
    },

    closeMenus: closeOpenMenu,
    storage: state.storage
  };

  /*
   * Preflight must happen immediately.
   * Eruda itself waits until the DOM exists.
   */
  preflight();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, {
      once: true
    });
  } else {
    boot();
  }
})(window, document);


/*
 * IP-004 — Eruda console history + Tab completion
 *
 * Append this to incompatipatch-eruda.js after the main loader.
 *
 * Features:
 * - ArrowUp / ArrowDown history at first/last textarea line.
 * - Ctrl+Enter keeps using Eruda's real Execute path.
 * - Tab completion for:
 *     docu        → document
 *     document.que → document.querySelector
 *     window.loc  → window.location
 * - No eval for completion. Only identifier.property chains.
 * - Small completion picker above the console textarea.
 */
(function (global, document) {
  'use strict';

  var patch = global.SevrinIncompatipatch;

  if (!patch || global.SevrinIncompatipatchConsoleExtras) {
    return;
  }

  var config = patch.config || {};

  if (config.console_history_max === undefined) {
    config.console_history_max = 150;
  }

  if (config.console_tab_complete === undefined) {
    config.console_tab_complete = true;
  }

  if (config.console_completion_max === undefined) {
    config.console_completion_max = 9;
  }

  var state = {
    history: [],
    cursor: 0,
    draft: '',
    popup: null,
    completion: null
  };

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function make(tag, text, styles) {
    var node = document.createElement(tag);

    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }

    if (styles) {
      for (var key in styles) {
        if (own(styles, key)) {
          node.style[key] = styles[key];
        }
      }
    }

    return node;
  }

  function setCaretToEnd(textarea) {
    var end = textarea.value.length;

    try {
      textarea.setSelectionRange(end, end);
    } catch (error) {
      /* Textarea remains usable even if selection APIs misbehave. */
    }
  }

  function emitInput(textarea) {
    var event;

    try {
      event = new Event('input', { bubbles: true });
    } catch (error) {
      event = document.createEvent('Event');
      event.initEvent('input', true, false);
    }

    textarea.dispatchEvent(event);
  }

  function remember(textarea) {
    var code = textarea.value.trim();

    if (!code) {
      return;
    }

    var history = state.history;

    /*
     * Re-running the immediately previous command should not turn
     * the history into "foo, foo, foo, foo" soup.
     */
    if (history.length && history[history.length - 1] === code) {
      state.cursor = history.length;
      state.draft = '';
      return;
    }

    history.push(code);

    if (history.length > config.console_history_max) {
      history.shift();
    }

    state.cursor = history.length;
    state.draft = '';
  }

  function isAtFirstLogicalLine(textarea) {
    var start = textarea.selectionStart;

    return textarea.value.slice(0, start).indexOf('\n') === -1;
  }

  function isAtLastLogicalLine(textarea) {
    var end = textarea.selectionEnd;

    return textarea.value.slice(end).indexOf('\n') === -1;
  }

  function historyUp(textarea) {
    if (!state.history.length) {
      return false;
    }

    if (state.cursor === state.history.length) {
      state.draft = textarea.value;
    }

    state.cursor = Math.max(0, state.cursor - 1);

    textarea.value = state.history[state.cursor];
    setCaretToEnd(textarea);
    emitInput(textarea);

    return true;
  }

  function historyDown(textarea) {
    if (!state.history.length) {
      return false;
    }

    if (state.cursor >= state.history.length) {
      return false;
    }

    state.cursor += 1;

    textarea.value =
      state.cursor === state.history.length
        ? state.draft
        : state.history[state.cursor];

    setCaretToEnd(textarea);
    emitInput(textarea);

    return true;
  }

  function getPropertyNames(value) {
    var names = [];
    var seen = Object.create(null);
    var current = value;
    var depth = 0;

    while (current && depth < 8) {
      var ownNames;

      try {
        ownNames = Object.getOwnPropertyNames(current);
      } catch (error) {
        ownNames = [];
      }

      for (var i = 0; i < ownNames.length; i++) {
        var name = ownNames[i];

        if (!seen[name]) {
          seen[name] = true;
          names.push(name);
        }
      }

      try {
        current = Object.getPrototypeOf(current);
      } catch (error) {
        current = null;
      }

      depth += 1;
    }

    return names;
  }

  function resolvePath(path) {
    var value = global;

    if (!path) {
      return value;
    }

    var parts = path.split('.');

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];

      if (!part) {
        return null;
      }

      try {
        value = value[part];
      } catch (error) {
        return null;
      }

      if (value === null || value === undefined) {
        return null;
      }
    }

    return value;
  }

  function completionContext(textarea) {
    var cursor = textarea.selectionStart;
    var before = textarea.value.slice(0, cursor);

    /*
     * Deliberately modest grammar:
     *   document.que
     *   window.loc
     *   navigator.us
     *   docu
     *
     * No eval, function calls, brackets, operators, or mystery code.
     */
    var match = before.match(
      /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\.?[A-Za-z0-9_$]*)$/
    );

    if (!match) {
      return null;
    }

    var token = match[1];
    var tokenStart = cursor - token.length;
    var dot = token.lastIndexOf('.');

    var basePath;
    var partial;

    if (dot === -1) {
      basePath = '';
      partial = token;
    } else {
      basePath = token.slice(0, dot);
      partial = token.slice(dot + 1);
    }

    var base = resolvePath(basePath);

    if (base === null) {
      return null;
    }

    var names = getPropertyNames(base);
    var lowerPartial = partial.toLowerCase();
    var candidates = [];

    for (var i = 0; i < names.length; i++) {
      var name = names[i];

      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        continue;
      }

      if (
        name.toLowerCase().slice(0, lowerPartial.length) ===
        lowerPartial
      ) {
        candidates.push(name);
      }
    }

    candidates.sort(function (a, b) {
      return a.localeCompare(b);
    });

    if (!candidates.length) {
      return null;
    }

    return {
      textarea: textarea,
      start: tokenStart + (dot === -1 ? 0 : dot + 1),
      end: cursor,
      basePath: basePath,
      partial: partial,
      candidates: candidates,
      index: -1
    };
  }

  function commonPrefix(words) {
    if (!words.length) {
      return '';
    }

    var prefix = words[0];

    for (var i = 1; i < words.length; i++) {
      var word = words[i];
      var length = Math.min(prefix.length, word.length);
      var index = 0;

      while (index < length && prefix[index] === word[index]) {
        index += 1;
      }

      prefix = prefix.slice(0, index);

      if (!prefix) {
        break;
      }
    }

    return prefix;
  }

  function replaceCompletion(completion, text) {
    var textarea = completion.textarea;
    var value = textarea.value;

    textarea.value =
      value.slice(0, completion.start) +
      text +
      value.slice(completion.end);

    completion.end = completion.start + text.length;

    try {
      textarea.setSelectionRange(completion.end, completion.end);
    } catch (error) {
      /* No-op. */
    }

    emitInput(textarea);
  }

  function closePopup() {
    if (state.popup && state.popup.parentNode) {
      state.popup.parentNode.removeChild(state.popup);
    }

    state.popup = null;
    state.completion = null;
  }

  function showPopup(completion) {
    if (!completion || !completion.candidates.length) {
      closePopup();
      return;
    }

    if (state.popup && state.popup.parentNode) {
      state.popup.parentNode.removeChild(state.popup);
    }

    var textarea = completion.textarea;
    var rect = textarea.getBoundingClientRect();

    var popup = make('div', null, {
      position: 'fixed',
      left: Math.round(rect.left) + 'px',
      bottom: Math.round(
        global.innerHeight - rect.top + 4
      ) + 'px',
      width: Math.max(180, Math.round(rect.width)) + 'px',
      maxHeight: '150px',
      overflowY: 'auto',
      boxSizing: 'border-box',
      border: '1px solid #596767',
      backgroundColor: '#101616',
      color: '#eaf3f3',
      zIndex: '2147483647',
      pointerEvents: 'auto',
      font: '11px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace'
    });

    var title = make(
      'div',
      completion.basePath
        ? completion.basePath + '.'
        : 'window.',
      {
        padding: '4px 7px',
        color: '#d9ff59',
        borderBottom: '1px solid #354040'
      }
    );

    popup.appendChild(title);

    var visible = Math.min(
      completion.candidates.length,
      config.console_completion_max
    );

    for (var i = 0; i < visible; i++) {
      (function (index) {
        var candidate = completion.candidates[index];

        var item = make('button', candidate, {
          display: 'block',
          width: '100%',
          minHeight: '24px',
          boxSizing: 'border-box',
          padding: '4px 7px',
          borderWidth: '0',
          borderBottom: '1px solid #263131',
          backgroundColor:
            index === completion.index
              ? '#293636'
              : '#101616',
          color:
            index === completion.index
              ? '#d9ff59'
              : '#eaf3f3',
          textAlign: 'left',
          cursor: 'pointer',
          pointerEvents: 'auto',
          font: 'inherit'
        });

        item.type = 'button';

        item.addEventListener('mousedown', function (event) {
          event.preventDefault();

          completion.index = index;
          replaceCompletion(completion, candidate);

          textarea.focus();
          closePopup();
        });

        popup.appendChild(item);
      })(i);
    }

    if (completion.candidates.length > visible) {
      popup.appendChild(
        make(
          'div',
          '… ' +
            (completion.candidates.length - visible) +
            ' more',
          {
            padding: '4px 7px',
            color: '#889898'
          }
        )
      );
    }

    document.body.appendChild(popup);

    state.popup = popup;
    state.completion = completion;
  }

  function cycleCompletion(direction) {
    var completion = state.completion;

    if (!completion || !completion.candidates.length) {
      return false;
    }

    var count = completion.candidates.length;

    completion.index =
      (completion.index + direction + count) % count;

    replaceCompletion(
      completion,
      completion.candidates[completion.index]
    );

    showPopup(completion);

    return true;
  }

  function tabComplete(textarea, backwards) {
    if (!config.console_tab_complete) {
      return false;
    }

    if (
      state.completion &&
      state.completion.textarea === textarea
    ) {
      return cycleCompletion(backwards ? -1 : 1);
    }

    var completion = completionContext(textarea);

    if (!completion) {
      return false;
    }

    if (completion.candidates.length === 1) {
      replaceCompletion(
        completion,
        completion.candidates[0]
      );

      return true;
    }

    var shared = commonPrefix(completion.candidates);

    if (shared.length > completion.partial.length) {
      replaceCompletion(completion, shared);
    }

    showPopup(completion);

    return true;
  }

  function patchTextarea(textarea) {
    if (
      !textarea ||
      textarea.getAttribute(
        'data-sevrin-console-extras'
      ) === 'true'
    ) {
      return;
    }

    textarea.setAttribute(
      'data-sevrin-console-extras',
      'true'
    );

    textarea.title = textarea.title
      ? textarea.title +
        '\nArrowUp/Down: history at input edges.' +
        '\nTab: property completion.' +
        '\nCtrl+Enter: run.'
      : 'ArrowUp/Down: history at input edges.' +
        '\nTab: property completion.' +
        '\nCtrl+Enter: run.';

    var host = textarea.closest
      ? textarea.closest('.eruda-js-input')
      : null;

    var execute = host
      ? host.querySelector('.eruda-execute')
      : null;

    /*
     * This target-level listener sees the value before Eruda's
     * delegated click handler clears the textarea.
     */
    if (execute) {
      execute.addEventListener(
        'click',
        function () {
          remember(textarea);
          closePopup();
        },
        true
      );
    }

    textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closePopup();
        return;
      }

      if (event.key === 'Tab') {
        if (tabComplete(textarea, !!event.shiftKey)) {
          event.preventDefault();
        }

        return;
      }

      if (
        event.key === 'ArrowUp' &&
        isAtFirstLogicalLine(textarea)
      ) {
        if (historyUp(textarea)) {
          event.preventDefault();
        }

        return;
      }

      if (
        event.key === 'ArrowDown' &&
        isAtLastLogicalLine(textarea)
      ) {
        if (historyDown(textarea)) {
          event.preventDefault();
        }

        return;
      }

      /*
       * Any normal edit means a previous popup no longer describes
       * the cursor's token.
       */
      if (
        event.key.length === 1 ||
        event.key === 'Backspace' ||
        event.key === 'Delete'
      ) {
        closePopup();
      }
    });

    textarea.addEventListener('blur', function () {
      setTimeout(closePopup, 120);
    });
  }

  function scan(root) {
    root = root || document;

    var textareas = root.querySelectorAll
      ? root.querySelectorAll('.eruda-js-input textarea')
      : [];

    for (var i = 0; i < textareas.length; i++) {
      patchTextarea(textareas[i]);
    }
  }

  scan(document);

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      for (
        var j = 0;
        j < records[i].addedNodes.length;
        j++
      ) {
        var node = records[i].addedNodes[j];

        if (node.nodeType === 1) {
          scan(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  global.SevrinIncompatipatchConsoleExtras = {
    clearHistory: function () {
      state.history = [];
      state.cursor = 0;
      state.draft = '';
    },

    history: function () {
      return state.history.slice();
    },

    closeCompletion: closePopup
  };
})(window, document);

/* ------------------------------------------------------------
 * IP-003 + IP-005
 * Eruda Storage inspector bridge + selected-log Ctrl+C.
 *
 * Append this whole block at the END of incompatipatch-eruda.js.
 * ---------------------------------------------------------- */
(function (global, document) {
  'use strict';

  var patch = global.SevrinIncompatipatch;

  if (!patch || global.SevrinIncompatipatchErudaAddendums) {
    return;
  }

  var config = patch.config || {};

  var state = {
    storageInstalled: false,
    copyInstalled: false,
    attempts: 0
  };

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function truncate(value, limit) {
    value = String(value);

    if (value.length <= limit) {
      return value;
    }

    return value.slice(0, limit) + '…';
  }

  function isErudaStorageKey(key) {
    return (
      key === 'active-eruda' ||
      key.slice(0, 5) === 'eruda'
    );
  }

  /*
   * This is the enumeration route Servo's native Storage supports:
   *
   *   storage.length
   *   storage.key(index)
   *   storage.getItem(key)
   *
   * It deliberately does NOT use JSON.stringify(storage), because
   * Servo currently serializes the Storage object as {"length": N}.
   */
  function readStorageRows(type) {
    var store = type === 'local'
      ? global.localStorage
      : global.sessionStorage;

    var rows = [];
    var length = 0;

    try {
      length = Number(store.length) || 0;
    } catch (error) {
      return rows;
    }

    for (var index = 0; index < length; index++) {
      var key;
      var value;

      try {
        key = store.key(index);

        if (key === null || key === undefined) {
          continue;
        }

        key = String(key);

        if (
          !config.show_eruda_storage_entries &&
          isErudaStorageKey(key)
        ) {
          continue;
        }

        value = store.getItem(key);

        if (typeof value !== 'string') {
          continue;
        }
      } catch (error) {
        continue;
      }

      rows.push({
        key: key,
        val: truncate(value, 200)
      });
    }

    rows.sort(function (a, b) {
      return a.key.localeCompare(b.key);
    });

    return rows;
  }

  /*
   * Eruda Resources owns two Storage instances:
   *
   *   resources._localStorage
   *   resources._sessionStorage
   *
   * Their public refresh() method calls _refreshStorage(), then
   * feeds _storeData into Eruda's existing grid. We replace only
   * that private enumeration step; its buttons, detail viewer,
   * delete, clear, filter, and refresh machinery stay untouched.
   */
  function patchStorageInspector(inspector) {
    if (
      !inspector ||
      typeof inspector._refreshStorage !== 'function'
    ) {
      return false;
    }

    if (inspector.__sevrinStorageInspectorBridge) {
      return true;
    }

    var originalRefreshStorage = inspector._refreshStorage;

    inspector.__sevrinStorageInspectorBridge = {
      originalRefreshStorage: originalRefreshStorage
    };

    inspector._refreshStorage = function () {
      this._storeData = readStorageRows(this._type);
    };

    return true;
  }

  function installStorageBridge() {
    if (!config.bridge_eruda_storage) {
      return true;
    }

    if (
      !global.eruda ||
      typeof global.eruda.get !== 'function'
    ) {
      return false;
    }

    var resources;

    try {
      resources = global.eruda.get('resources');
    } catch (error) {
      return false;
    }

    if (
      !resources ||
      !resources._localStorage ||
      !resources._sessionStorage
    ) {
      return false;
    }

    var localReady = patchStorageInspector(
      resources._localStorage
    );

    var sessionReady = patchStorageInspector(
      resources._sessionStorage
    );

    if (!localReady || !sessionReady) {
      return false;
    }

    /*
     * Populate either panel immediately if Resources is already
     * open. Future refresh-button clicks automatically use the
     * bridged enumeration route too.
     */
    try {
      resources.refreshLocalStorage();
      resources.refreshSessionStorage();
    } catch (error) {
      /* The bridge is installed even if Eruda is mid-render. */
    }

    state.storageInstalled = true;

    return true;
  }

  function isEditable(node) {
    if (!node) {
      return false;
    }

    if (
      node.tagName === 'TEXTAREA' ||
      node.tagName === 'INPUT'
    ) {
      return true;
    }

    return !!node.isContentEditable;
  }

  function hasRealTextSelection() {
    if (!global.getSelection) {
      return false;
    }

    var selection = global.getSelection();

    return !!(
      selection &&
      !selection.isCollapsed &&
      String(selection)
    );
  }

  /*
   * Eruda turns clicking a log into a structured selected-log state.
   * Its own Copy icon then calls selectedLog.copy().
   *
   * We click that existing control instead of inventing a second
   * object serializer. This preserves Eruda's own text representation
   * and its "Copied" notification.
   */
  function installConsoleCopyShortcut() {
    if (
      state.copyInstalled ||
      !config.console_copy_shortcut
    ) {
      return true;
    }

    document.addEventListener(
      'keydown',
      function (event) {
        var key = String(event.key || '').toLowerCase();

        if (
          !(
            (event.ctrlKey || event.metaKey) &&
            key === 'c'
          )
        ) {
          return;
        }

        /*
         * Never steal normal clipboard copy from:
         * - the command textarea
         * - text inputs
         * - any contenteditable page element
         * - a genuine mouse-selected text range
         */
        if (
          isEditable(document.activeElement) ||
          hasRealTextSelection()
        ) {
          return;
        }

        var selectedLog = document.querySelector(
          '#eruda .luna-console .log-container.selected'
        );

        if (!selectedLog) {
          return;
        }

        var copyButton = document.querySelector(
          '#eruda .eruda-copy:not(.eruda-icon-disabled)'
        );

        if (!copyButton) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        copyButton.click();
      },
      true
    );

    state.copyInstalled = true;

    return true;
  }

  function install() {
    var storageReady = installStorageBridge();
    var copyReady = installConsoleCopyShortcut();

    if (storageReady && copyReady) {
      return true;
    }

    return false;
  }

  function waitForEruda() {
    if (install()) {
      return;
    }

    state.attempts += 1;

    /*
     * The main Incompatipatch dynamically injects Eruda, so this
     * append block can arrive first. Four seconds is generous while
     * still failing honestly instead of polling forever.
     */
    if (state.attempts < 160) {
      setTimeout(waitForEruda, 25);
      return;
    }

    console.warn(
      '[Incompatipatch] IP-003 storage bridge could not find Eruda Resources.'
    );
  }

  global.SevrinIncompatipatchErudaAddendums = {
    refreshStorage: function () {
      if (!installStorageBridge()) {
        return false;
      }

      var resources = global.eruda.get('resources');

      resources.refreshLocalStorage();
      resources.refreshSessionStorage();

      return true;
    },

    storageRows: function (type) {
      return readStorageRows(type || 'local');
    }
  };

  waitForEruda();
})(window, document);



/*
 * IP-006 — Eruda legacy copy bridge, Servo edition
 *
 * Eruda/Licia creates an offscreen readonly textarea containing the
 * copy payload, then calls document.execCommand("copy").
 *
 * Servo does not expose that temporary selection as activeElement or
 * window.getSelection(), so we locate the temporary textarea itself
 * and send its value through navigator.clipboard.writeText().
 */
(function (global, document) {
  'use strict';

  var patch = global.SevrinIncompatipatch;

  if (
    !patch ||
    !patch.config ||
    !patch.config.legacy_copy_bridge
  ) {
    return;
  }

  if (
    !navigator.clipboard ||
    typeof navigator.clipboard.writeText !== 'function' ||
    typeof document.execCommand !== 'function'
  ) {
    console.warn(
      '[Incompatipatch] IP-006 unavailable: clipboard or execCommand missing.'
    );
    return;
  }

  var originalExecCommand = document.execCommand.bind(document);

  function findLegacyCopyTextarea() {
    var controls = document.querySelectorAll(
      'textarea[readonly], input[readonly]'
    );

    /*
     * Licia appends its temporary textarea at the end of <body>,
     * gives it position:absolute and left:-9999px, then immediately
     * calls execCommand("copy"). Search backward for the newest match.
     */
    for (var i = controls.length - 1; i >= 0; i--) {
      var control = controls[i];
      var left = parseInt(control.style.left, 10);

      var looksLikeLiciaCopyBox =
        control.style.position === 'absolute' &&
        Number.isFinite(left) &&
        left <= -9000;

      if (looksLikeLiciaCopyBox) {
        return control;
      }
    }

    return null;
  }

  function selectedTextFallback() {
    var active = document.activeElement;

    if (
      active &&
      (active.tagName === 'TEXTAREA' ||
        active.tagName === 'INPUT') &&
      typeof active.selectionStart === 'number' &&
      typeof active.selectionEnd === 'number'
    ) {
      var selected = active.value.slice(
        active.selectionStart,
        active.selectionEnd
      );

      if (selected) {
        return {
          text: selected,
          source: 'active control selection'
        };
      }
    }

    if (global.getSelection) {
      var selection = global.getSelection();
      var text = selection ? String(selection) : '';

      if (text) {
        return {
          text: text,
          source: 'document selection'
        };
      }
    }

    return {
      text: '',
      source: 'none'
    };
  }

  document.execCommand = function (command) {
    var normalized = String(command || '').toLowerCase();

    if (normalized !== 'copy') {
      return originalExecCommand.apply(document, arguments);
    }

    var copyBox = findLegacyCopyTextarea();
    var payload;

    if (copyBox) {
      payload = {
        text: String(copyBox.value || ''),
        source: 'Licia offscreen textarea'
      };
    } else {
      payload = selectedTextFallback();
    }

    if (!payload.text) {
      console.warn(
        '[Incompatipatch] IP-006 intercepted copy but found no payload.',
        {
          activeTag:
            document.activeElement &&
            document.activeElement.tagName,
          source: payload.source
        }
      );

      return originalExecCommand.apply(document, arguments);
    }

    console.log(
      '[Incompatipatch] IP-006 copying via Clipboard API:',
      {
        source: payload.source,
        length: payload.text.length,
        preview: payload.text.slice(0, 120)
      }
    );

    /*
     * Start this immediately inside Eruda's click / Ctrl+C gesture.
     * The returned promise cannot be awaited by old execCommand callers,
     * so true means “accepted for modern clipboard delivery.”
     */
    navigator.clipboard.writeText(payload.text).then(
      function () {
        console.log(
          '[Incompatipatch] IP-006 clipboard write resolved.'
        );
      },
      function (error) {
        console.error(
          '[Incompatipatch] IP-006 clipboard write rejected:',
          error
        );
      }
    );

    return true;
  };

  global.SevrinIncompatipatchLegacyCopy = {
    uninstall: function () {
      document.execCommand = originalExecCommand;
      delete global.SevrinIncompatipatchLegacyCopy;
    }
  };

  console.info(
    '[Incompatipatch] IP-006 legacy copy bridge installed.'
  );
})(window, document);


