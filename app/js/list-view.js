// Reusable filter bar + grouped list + side panel shell.
// Depends on `escHtml` from core.js (loaded on every app page).

// Available filter types — the only valid values for FilterDef.type.
// Each entry also documents its optional `field` annotation:
//   field: the item property the filter reads (documentation only; getData handles the actual logic).
// Async filters omit `field` because the resolved value drives filtering indirectly.
var FILTER_TYPES = {
  // Plain text search. Re-renders immediately on each keystroke.
  // state value: lowercase string ('' = inactive)
  // field: item property matched with .toLowerCase().includes() — e.g. 'title'
  TEXT: 'text',

  // Single checkbox. Renders inline in the filter bar row.
  // state value: boolean
  // field: item property tested for truthiness — e.g. 'active'
  // opts: { default: true|false }  — initial checked state (default false)
  CHECKBOX: 'checkbox',

  // Clickable pill buttons derived from current data. Renders in a second bar row.
  // Toggling a chip sets the filter to that value; toggling again clears it.
  // state value: string ('' = inactive)
  // field: item property matched with strict equality — e.g. 'genre'
  // opts: { getValues: fn(state) → string[] }  — called on every render to populate pills;
  //        `state` is the current filter state, so values can be narrowed to what matches
  CHIPS: 'chips',

  // Text input with debounce + async resolution. Re-renders after resolve() settles.
  // state value: whatever resolve() returns (Set, array, null, ...)
  // field: omit — the resolved value IS the filter; getData handles the mapping
  // opts: { resolve: async fn(str) → any, debounce?: number (default 400 ms) }
  ASYNC_TEXT: 'async-text',
};

function createListView(opts) {
  opts.filters = opts.filters || [];

  // Private state — all internal, nothing exposed
  var _state    = {};   // { filterId: rawValue }
  var _resolved = {};   // { filterId: resolvedValue } — async filters only
  var _asyncRaw = {};   // { filterId: rawString } — raw input for async filters
  var _pending  = {};   // { filterId: timerId } — debounce timers
  var _selectedId = null;
  var _collapsed  = null; // Set<groupKey> | null — null until first render
  var _items      = [];   // last getData() result

  // Initialise _state from filter defaults
  opts.filters.forEach(function(f) {
    if (f.type === FILTER_TYPES.CHECKBOX) {
      _state[f.id] = f['default'] === true;
    } else if (f.type === FILTER_TYPES.ASYNC_TEXT) {
      _resolved[f.id] = undefined;
      _asyncRaw[f.id] = '';
    } else if (f.type === FILTER_TYPES.CHIPS && f.multi) {
      _state[f.id] = [];
    } else {
      _state[f.id] = '';
    }
  });

  function _renderFilterBar() {
    var row1Fields = opts.filters.filter(function(f) {
      return f.type !== FILTER_TYPES.CHIPS;
    });
    var hasChips = opts.filters.some(function(f) { return f.type === FILTER_TYPES.CHIPS; });

    var fieldsHtml = row1Fields.map(function(f) {
      if (f.type === FILTER_TYPES.TEXT || f.type === FILTER_TYPES.ASYNC_TEXT) {
        return '<label class="filter-bar-field">' +
          '<span class="filter-bar-label">' + escHtml(f.label) + '</span>' +
          '<input type="text" id="lv-f-' + escHtml(f.id) + '" class="filter-bar-input"' +
          ' placeholder="' + t('list.searchPlaceholder') + '" autocomplete="off">' +
          '</label>';
      }
      if (f.type === FILTER_TYPES.CHECKBOX) {
        return '<label class="filter-bar-active">' +
          '<input type="checkbox" id="lv-f-' + escHtml(f.id) + '"' +
          (f['default'] ? ' checked' : '') + '> ' + escHtml(f.label) +
          '</label>';
      }
      return '';
    }).join('');

    var actionsHtml = (opts.actions || []).map(function(a) {
      var cls = 'btn' +
        (a.desktopOnly  ? ' btn-desktop-only' : '') +
        (a.authRequired ? ' auth-only'        : '') +
        (a.icon         ? ' icon-btn'         : '');
      var titleAttr = a.title ? ' title="' + escHtml(a.title) + '"' : '';
      var content   = a.icon  ? a.icon : escHtml(a.label);
      return '<button class="' + cls + '" data-lv-action="' + escHtml(a.label) + '"' + titleAttr + '>' +
        content + '</button>';
    }).join('');

    var countHtml = '<span class="filter-count" id="lv-count"></span>';

    var row2Html = hasChips ? '<div class="filter-bar-row2" id="lv-chips-row"></div>' : '';

    opts.container.innerHTML =
      '<div class="filter-bar" id="lv-filter-bar">' +
        '<div class="filter-bar-row1">' +
          fieldsHtml + countHtml + actionsHtml +
        '</div>' +
        row2Html +
      '</div>' +
      '<div class="lv-body" id="lv-body"></div>';
  }

  function _runPipeline() {
    var merged = Object.assign({}, _state, _resolved);
    _items = opts.getData(merged);

    // Deselect if the selected item is no longer visible
    if (_selectedId !== null) {
      var stillVisible = _items.some(function(item) {
        return String(opts.getItemId(item)) === _selectedId;
      });
      if (!stillVisible) _closePanel();
    }

    _renderBody();
    _renderChips();
    _updateCount();
  }

  function _renderBody() {
    var body = document.getElementById('lv-body');
    if (!body) return;

    if (!_items.length) {
      // Truly no data (not just filtered to zero) → page-specific empty-state CTA
      var _isEmpty = typeof opts.getTotal === 'function' && opts.getTotal() === 0;
      body.innerHTML = (_isEmpty && opts.emptyHtml)
        ? opts.emptyHtml
        : '<p style="text-align:center;color:var(--third-color);padding:2rem;">' + t('list.noResults') + '</p>';
      return;
    }

    if (opts.groupBy) {
      _renderGroupedList(_items);
    } else {
      body.innerHTML = _items.map(opts.renderRow).join('');
      if (_selectedId) {
        var el = body.querySelector('[data-id="' + _selectedId + '"]');
        if (el) el.classList.add('lv-row--selected');
      }
    }
  }

  function _updateCount() {
    var countEl = document.getElementById('lv-count');
    if (!countEl) return;
    var total = opts.getTotal
      ? opts.getTotal()
      : opts.getData({}).length;
    countEl.textContent = _items.length + ' / ' + total;
  }

  function _renderChips() {
    var row2 = document.getElementById('lv-chips-row');
    if (!row2) return;
    var chipsFilters = opts.filters.filter(function(f) { return f.type === FILTER_TYPES.CHIPS; });
    row2.innerHTML = chipsFilters.map(_chipsGroupHtml).join('');
  }

  // Pass the live filter state so the page can offer only the values that still
  // have matching rows (e.g. no genre chips for genres without an active song).
  // A multi filter holds an array of selected values; a single one a string.
  function _chipsGroupHtml(chipsFilter) {
    var values = chipsFilter.getValues
      ? chipsFilter.getValues(Object.assign({}, _state, _resolved))
      : [];
    var selected = chipsFilter.multi ? (_state[chipsFilter.id] || []) : [_state[chipsFilter.id] || ''].filter(Boolean);
    // Keep selected chips visible even when nothing matches them any more, otherwise
    // the filter stays applied with no way to switch it off.
    var missing = selected.filter(function(v) { return values.indexOf(v) === -1; });
    if (missing.length) values = values.concat(missing).sort();
    if (!values.length) return '';

    var chips = values.map(function(v) {
      var isSel = selected.indexOf(v) !== -1;
      return '<button class="genre-chip' + (isSel ? ' genre-chip--active' : '') +
        '" data-lv-chip="' + escHtml(v) + '" data-filter-id="' + escHtml(chipsFilter.id) + '">' +
        escHtml(v) + '</button>';
    }).join('');
    return '<div class="lv-chips-group"><span class="filter-genre-label">' + escHtml(chipsFilter.label) + ':</span>' + chips + '</div>';
  }

  function _renderGroupedList(items) {
    var body = document.getElementById('lv-body');
    if (!body) return;

    // Bucket items by group key
    var buckets = {};
    var order = [];
    items.forEach(function(item) {
      var key = opts.groupBy(item);
      if (!buckets[key]) { buckets[key] = []; order.push(key); }
      buckets[key].push(item);
    });

    // Sort group keys
    var sortFn = opts.groupSort || function(a, b) { return b > a ? 1 : -1; };
    order.sort(sortFn);

    // Init collapse state on first render: collapse all but topmost group
    if (_collapsed === null) {
      _collapsed = new Set(order.slice(1));
    }

    // Filter active → show all groups
    var filterActive = opts.filters.some(function(f) {
      if (f.type === FILTER_TYPES.ASYNC_TEXT) return _resolved[f.id] !== undefined;
      var v = _state[f.id];
      if (f.type === FILTER_TYPES.CHECKBOX) return f['default'] ? !v : v;
      return v && v !== '';
    });

    var html = order.map(function(key) {
      var groupItems = buckets[key];
      var isCollapsed = !filterActive && _collapsed.has(key);
      var count = groupItems.length;
      var rowsHtml = groupItems.map(opts.renderRow).join('');
      var safeKey = escHtml(key);
      return '<div class="list-group" data-lv-group-wrap="' + safeKey + '">' +
        '<div class="list-group-heading" role="button" tabindex="0" data-lv-group="' + safeKey + '">' +
          '<span class="list-group-label">' + safeKey + '</span>' +
          '<span class="list-group-count"' + (isCollapsed ? '' : ' style="display:none"') + '>' +
            t(count !== 1 ? 'list.groupCount_other' : 'list.groupCount_one', { count: count }) +
          '</span>' +
          '<span class="list-group-toggle" aria-hidden="true">' + (isCollapsed ? '&#9660;' : '&#9650;') + '</span>' +
        '</div>' +
        '<div class="list-group-body"' + (isCollapsed ? ' hidden' : '') + '>' +
          rowsHtml +
        '</div>' +
      '</div>';
    }).join('');

    body.innerHTML = html;

    // Restore selection highlight after re-render
    if (_selectedId) {
      var el = body.querySelector('[data-id="' + _selectedId + '"]');
      if (el) el.classList.add('lv-row--selected');
    }
  }

  function _toggleGroup(key) {
    if (!_collapsed) _collapsed = new Set();
    var wrap = document.querySelector('[data-lv-group-wrap="' + key + '"]');
    if (!wrap) return;
    var groupBody = wrap.querySelector('.list-group-body');
    var toggle    = wrap.querySelector('.list-group-toggle');
    var count     = wrap.querySelector('.list-group-count');

    if (_collapsed.has(key)) {
      _collapsed.delete(key);
      if (groupBody) groupBody.hidden = false;
      if (toggle) toggle.innerHTML = '&#9650;';
      if (count) count.style.display = 'none';
    } else {
      _collapsed.add(key);
      if (groupBody) groupBody.hidden = true;
      if (toggle) toggle.innerHTML = '&#9660;';
      if (count) count.style.display = '';
    }
  }

  function _wireFilterEvents() {
    opts.filters.forEach(function(f) {
      var el = document.getElementById('lv-f-' + f.id);
      if (!el) return;

      if (f.type === FILTER_TYPES.TEXT) {
        el.addEventListener('input', function(e) {
          _state[f.id] = e.target.value.toLowerCase();
          _runPipeline();
        });
      }

      if (f.type === FILTER_TYPES.CHECKBOX) {
        el.addEventListener('change', function(e) {
          _state[f.id] = e.target.checked;
          _runPipeline();
        });
      }

      if (f.type === FILTER_TYPES.ASYNC_TEXT) {
        el.addEventListener('input', function(e) {
          _onAsyncInput(f, e.target.value);
        });
      }
    });

    // Chip clicks — event delegation on chips row
    var chipsRow = document.getElementById('lv-chips-row');
    if (chipsRow) {
      chipsRow.addEventListener('click', function(e) {
        var chip = e.target.closest('[data-lv-chip]');
        if (!chip) return;
        var filterId = chip.dataset.filterId;
        var value    = chip.dataset.lvChip;
        var f = opts.filters.find(function(x) { return x.id === filterId; });
        if (f && f.multi) {
          var sel = _state[filterId] || [];
          _state[filterId] = sel.indexOf(value) === -1
            ? sel.concat(value)
            : sel.filter(function(v) { return v !== value; });
        } else {
          _state[filterId] = (_state[filterId] === value) ? '' : value;
        }
        _runPipeline();
      });
    }

    // Action button clicks
    var filterBar = document.getElementById('lv-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-lv-action]');
        if (!btn) return;
        var label = btn.dataset.lvAction;
        var action = (opts.actions || []).find(function(a) { return a.label === label; });
        if (action && action.onClick) action.onClick(btn);
      });
    }
  }

  function _onAsyncInput(f, value) {
    clearTimeout(_pending[f.id]);
    _asyncRaw[f.id] = value;

    if (!value.trim()) {
      delete _resolved[f.id];
      _runPipeline();
      return;
    }

    var debounce = f.debounce != null ? f.debounce : 400;
    _pending[f.id] = setTimeout(function() {
      var capturedValue = value;
      Promise.resolve(f.resolve(capturedValue)).then(function(result) {
        if (_asyncRaw[f.id] !== capturedValue) return; // superseded
        _resolved[f.id] = result;
        _runPipeline();
      }).catch(function() {
        if (_asyncRaw[f.id] !== capturedValue) return;
        delete _resolved[f.id];
        _runPipeline();
      });
    }, debounce);
  }

  function _wireBodyEvents() {
    var body = document.getElementById('lv-body');
    if (!body) return;

    body.addEventListener('click', function(e) {
      // Group heading toggle
      var heading = e.target.closest('[data-lv-group]');
      if (heading) {
        _toggleGroup(heading.dataset.lvGroup);
        return;
      }

      // Row click — find closest element with data-id
      var row = e.target.closest('[data-id]');
      if (!row) return;
      var id = row.dataset.id;

      if (opts.onRowClick) {
        opts.onRowClick(id, { openPanel: _openPanel, closePanel: _closePanel });
        return;
      }

      if (id === _selectedId) {
        _closePanel();
      } else {
        _openPanel(id);
      }
    });

    // Keyboard: Enter / Space on group headings
    body.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var heading = e.target.closest('[data-lv-group]');
      if (!heading) return;
      e.preventDefault();
      _toggleGroup(heading.dataset.lvGroup);
    });
  }

  function _openPanel(id) {
    id = String(id);

    // Auto-expand collapsed group containing the target
    if (opts.groupBy && _collapsed) {
      var item = _items.find(function(x) { return String(opts.getItemId(x)) === id; });
      if (item) {
        var key = opts.groupBy(item);
        if (_collapsed.has(key)) _toggleGroup(key);
      }
    }

    // Clear previous selection
    var prev = document.querySelector('.lv-row--selected');
    if (prev) prev.classList.remove('lv-row--selected');

    _selectedId = id;
    var el = document.querySelector('[data-id="' + id + '"]');
    if (el) el.classList.add('lv-row--selected');

    var panel = document.getElementById('view-side-panel');
    var inner = document.getElementById('view-side-panel-inner');
    if (!panel || !inner) return;

    // Loading placeholder while onOpen runs
    inner.innerHTML = skeletonHtml(4);
    panel.classList.add('open');
    opts.container.classList.add('side-panel-open');
    if (window.innerWidth <= 1024) document.body.style.overflow = 'hidden';

    if (opts.onOpen) {
      var item = _items.find(function(x) { return String(opts.getItemId(x)) === id; });
      if (item) {
        Promise.resolve(opts.onOpen(item, inner)).catch(function() {
          if (_selectedId === id) {
            inner.innerHTML = '<p style="color:var(--third-color);padding:1rem;">' + t('list.couldNotLoadDetails') + '</p>';
          }
        });
      }
    }
  }

  function _closePanel() {
    var panel = document.getElementById('view-side-panel');
    if (panel) panel.classList.remove('open');
    opts.container.classList.remove('side-panel-open');
    document.body.style.overflow = '';

    var prev = document.querySelector('.lv-row--selected');
    if (prev) prev.classList.remove('lv-row--selected');

    _selectedId = null;
    if (opts.onClose) opts.onClose();
  }

  function _setFilterValue(id, v) {
    var f = opts.filters.find(function(x) { return x.id === id; });
    if (!f) return;

    var el = document.getElementById('lv-f-' + id);

    if (f.type === FILTER_TYPES.TEXT) {
      _state[id] = String(v).toLowerCase();
      if (el) el.value = v;
      _runPipeline();
    } else if (f.type === FILTER_TYPES.CHECKBOX) {
      _state[id] = !!v;
      if (el) el.checked = !!v;
      _runPipeline();
    } else if (f.type === FILTER_TYPES.CHIPS) {
      _state[id] = f.multi ? [].concat(v || []).map(String) : String(v);
      _runPipeline();
    } else if (f.type === FILTER_TYPES.ASYNC_TEXT) {
      if (el) el.value = v;
      _onAsyncInput(f, v);
    }
  }

  var _public = Object.freeze({
    refresh:        function() { _runPipeline(); },
    select:         function(id) { _openPanel(String(id)); },
    deselect:       function() { _closePanel(); },
    setFilterValue: function(id, v) { _setFilterValue(id, v); },
  });

  // Init
  _renderFilterBar();
  _wireFilterEvents();
  _wireBodyEvents();
  _runPipeline();

  opts.container.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _selectedId) _closePanel();
  });

  return _public;
}
