(function () {
  'use strict';

  var STATUS_COLORS = {
    confirmed: '#22c55e',
    active:    '#3b82f6',
    contacted: '#f59e0b',
    prospect:  '#a855f7',
    declined:  '#ef4444',
    '':        '#94a3b8',
  };

  var _map        = null;
  var _slug       = '';
  var _allVenues  = [];
  var _markers    = [];
  var _leafletReady  = false;
  var _dataReady     = false;
  var _confirmedOnly = true; // load only confirmed venues by default

  // Filter state — all enabled by default
  var _statusFilter   = {};
  var _categoryFilter = {};
  var _sizeFilter     = 'any';
  var _textFilter     = '';

  // Lazy-load Leaflet JS once; CSS is already in <head>.
  // Queues concurrent callers so only one <script> tag is ever injected.
  var _leafletCallbacks = null;
  window.loadLeaflet = function (cb) {
    if (window.L) { cb(); return; }
    if (_leafletCallbacks) { _leafletCallbacks.push(cb); return; }
    _leafletCallbacks = [cb];
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
    s.crossOrigin = '';
    s.onload = function() {
      var cbs = _leafletCallbacks;
      _leafletCallbacks = null;
      cbs.forEach(function(f) { f(); });
    };
    document.head.appendChild(s);
  };

  function _markerIcon(status) {
    var color = STATUS_COLORS[(status || '').toLowerCase()] || STATUS_COLORS[''];
    return L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;border-radius:50%;background:' + color +
            ';border:2px solid rgba(0,0,0,0.25);box-shadow:0 1px 3px rgba(0,0,0,0.35)"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
      popupAnchor: [0, -8],
    });
  }

  function _passes(v) {
    if (_textFilter) {
      var q = _textFilter.toLowerCase();
      var hay = [v.name, v.city, v.country, v.postcode, v.street].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    var anyStatusUnchecked = window.VENUE_STATUSES.some(function(s) { return !_statusFilter[s.value]; });
    if (anyStatusUnchecked && !_statusFilter[(v.status || '').toLowerCase()]) return false;
    var anyCatUnchecked = window.VENUE_CATEGORIES.some(function(c) { return !_categoryFilter[c.value]; });
    if (anyCatUnchecked && !_categoryFilter[(v.category || '').toLowerCase()]) return false;
    if (_sizeFilter !== 'any') {
      if (_sizeFilter === 'small'  && (v.size == null || v.size >= 100))           return false;
      if (_sizeFilter === 'medium' && (v.size == null || v.size < 100 || v.size > 500)) return false;
      if (_sizeFilter === 'large'  && (v.size == null || v.size <= 500))           return false;
    }
    return true;
  }

  window._mapFilterText = function(val) {
    _textFilter = val.trim();
    _renderMarkers();
  };

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _popup(v) {
    if (!!(window._venueViewMode)) {
      return '<div><strong>' + _escHtml(v.name) + '</strong></div>';
    }
    var color  = STATUS_COLORS[(v.status || '').toLowerCase()] || STATUS_COLORS[''];
    var status = v.status
      ? '<span style="background:' + color + ';color:#fff;padding:1px 7px;border-radius:10px;font-size:0.75rem">' + _escHtml(v.status) + '</span> '
      : '';
    var cat  = v.category ? '<div style="color:#666;font-size:0.8rem">' + _escHtml(v.category) + '</div>' : '';
    var loc  = [v.city, v.country].filter(Boolean).map(_escHtml).join(', ');
    var size = v.size ? '<div style="color:#666;font-size:0.8rem">Capacity: ' + _escHtml(v.size) + '</div>' : '';
    return '<div style="min-width:140px"><strong>' + _escHtml(v.name) + '</strong>' +
      (loc ? '<div style="color:#555;font-size:0.82rem;margin:2px 0">' + loc + '</div>' : '') +
      status + cat + size +
      '<div style="margin-top:6px"><a href="#" onclick="event.preventDefault();openVenueFromMap(' + v.id + ')" style="font-size:0.8rem">View &#8594;</a></div>' +
      '</div>';
  }

  function _renderMarkers() {
    _markers.forEach(function(m) { m.remove(); });
    _markers = [];
    var visible = _allVenues.filter(function(v) { return v.lat && v.lng && _passes(v); });
    visible.forEach(function(v) {
      var m = L.marker([v.lat, v.lng], { icon: _markerIcon(v.status || '') });
      m.bindPopup(_popup(v));
      m.addTo(_map);
      _markers.push(m);
    });
    _updateUnmappedCount();
  }

  function _updateUnmappedCount() {
    if (!!(window._venueViewMode)) return; // geocode section hidden in view mode
    var noCoords = _allVenues.filter(function(v) { return !v.lat || !v.lng; }).length;
    var msgEl = document.getElementById('map-unmapped-msg');
    var secEl = document.getElementById('map-geocode-section');
    if (msgEl) msgEl.textContent = noCoords > 0
      ? noCoords + ' venue' + (noCoords !== 1 ? 's' : '') + ' not on map'
      : '';
    if (secEl) secEl.style.display = noCoords > 0 ? '' : 'none';
  }

  function _buildSidebar() {
    var sb = document.getElementById('map-sidebar');
    if (!sb) return;
    var viewMode = !!(window._venueViewMode);

    // In view mode only the legend is shown (text search is above the map)
    if (viewMode) {
      var legendHtmlOnly = '<div class="map-filter-label">Legend</div>';
      Object.keys(STATUS_COLORS).forEach(function(k) {
        if (!k) return;
        legendHtmlOnly += '<div class="map-filter-row">' +
          '<span class="map-legend-dot" style="background:' + STATUS_COLORS[k] + '"></span>' +
          _escHtml(k.charAt(0).toUpperCase() + k.slice(1)) + '</div>';
      });
      legendHtmlOnly += '<div class="map-filter-row"><span class="map-legend-dot" style="background:' + STATUS_COLORS[''] + '"></span>No status</div>';
      sb.innerHTML = legendHtmlOnly;
      return;
    }

    var statusHtml = '<div class="map-filter-label">Status</div>';
    window.VENUE_STATUSES.forEach(function(s) {
      _statusFilter[s.value] = true;
      statusHtml += '<label class="map-filter-row">' +
        '<input type="checkbox" checked onchange="window._mapFilterStatus(\'' + s.value + '\',this.checked)">' +
        '<span class="map-legend-dot" style="background:' + (STATUS_COLORS[s.value] || STATUS_COLORS['']) + '"></span>' +
        _escHtml(s.label) + '</label>';
    });
    _statusFilter[''] = true;

    var catHtml = '<div class="map-filter-label">Category</div>';
    window.VENUE_CATEGORIES.forEach(function(c) {
      _categoryFilter[c.value] = true;
      catHtml += '<label class="map-filter-row">' +
        '<input type="checkbox" checked onchange="window._mapFilterCategory(\'' + c.value + '\',this.checked)">' +
        _escHtml(c.label) + '</label>';
    });
    _categoryFilter[''] = true;

    var sizeHtml = '<div class="map-filter-label">Size</div>' +
      '<div class="map-size-btns">' +
      '<button class="map-size-btn active" data-size="any"    onclick="window._mapFilterSize(\'any\')">Any</button>' +
      '<button class="map-size-btn"        data-size="small"  onclick="window._mapFilterSize(\'small\')">&lt;100</button>' +
      '<button class="map-size-btn"        data-size="medium" onclick="window._mapFilterSize(\'medium\')" style="font-size:0.73rem">100–500</button>' +
      '<button class="map-size-btn"        data-size="large"  onclick="window._mapFilterSize(\'large\')">&gt;500</button>' +
      '</div>';

    // No separate legend needed — the status checkboxes already show colored dots

    var geocodeHtml =
      '<div id="map-geocode-section" style="display:none;margin-top:0.75rem">' +
      '<button id="map-geocode-btn" class="btn active" onclick="window.runBulkGeocode()">Get coordinates</button>' +
      '<div id="map-geocode-progress" style="display:none;font-size:0.75rem;color:var(--third-color);margin-top:0.3rem"></div>' +
      '<div id="map-unmapped-msg" style="font-size:0.75rem;color:var(--third-color);margin-top:0.3rem"></div>' +
      '</div>';

    var scopeHtml =
      '<div class="map-filter-label" style="margin-top:0">Show</div>' +
      '<div style="display:flex;flex-direction:column;gap:0.2rem;margin-bottom:0.5rem">' +
        '<label class="map-filter-row" style="cursor:pointer">' +
          '<input type="radio" name="map-scope" value="confirmed" ' + (_confirmedOnly ? 'checked' : '') + ' onchange="window._mapScopeChange(this.value)"> Confirmed only</label>' +
        '<label class="map-filter-row" style="cursor:pointer">' +
          '<input type="radio" name="map-scope" value="all" ' + (!_confirmedOnly ? 'checked' : '') + ' onchange="window._mapScopeChange(this.value)"> All venues</label>' +
      '</div>' +
      '<button id="map-load-btn" class="btn active" onclick="window._mapLoad()" style="width:100%;margin-bottom:0.75rem;font-size:0.78rem;padding:0.35rem 0.5rem">Load</button>';

    sb.innerHTML = scopeHtml + statusHtml + catHtml + sizeHtml + geocodeHtml;
  }

  window._mapScopeChange = function(val) {
    _confirmedOnly = (val === 'confirmed');
  };

  window._mapLoad = function() {
    var btn = document.getElementById('map-load-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    _dataReady = false;
    _allVenues = [];
    var url = '/api/' + _slug + '/venues?all=1' + (_confirmedOnly ? '&status=confirmed' : '');
    fetch(url)
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(venues) {
        _allVenues = venues;
        _dataReady = true;
        _buildSidebar();
        _renderMarkers();
        if (_markers.length > 0) {
          var group = L.featureGroup(_markers);
          _map.fitBounds(group.getBounds().pad(0.2));
        }
      })
      .catch(function() {
        if (btn) { btn.disabled = false; btn.textContent = 'Load'; }
      });
  };

  window._mapFilterStatus = function(val, checked) {
    _statusFilter[val] = checked;
    _renderMarkers();
  };
  window._mapFilterCategory = function(val, checked) {
    _categoryFilter[val] = checked;
    _renderMarkers();
  };
  window._mapFilterSize = function(val) {
    _sizeFilter = val;
    document.querySelectorAll('.map-size-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.size === val);
    });
    _renderMarkers();
  };

  function _initLeafletMap() {
    var canvas = document.getElementById('map-canvas');
    if (!canvas || _map) return;
    _map = L.map(canvas, { zoomControl: true }).setView([48.5, 9.0], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(_map);
  }

  function _tryRender() {
    if (!_leafletReady || !_dataReady) return;
    _initLeafletMap();
    _buildSidebar();
    _renderMarkers();
    if (_markers.length > 0) {
      var group = L.featureGroup(_markers);
      _map.fitBounds(group.getBounds().pad(0.2));
    }
    setTimeout(function() { if (_map) _map.invalidateSize(); }, 50);
  }

  window.initMap = function(slug) {
    _slug = slug;
    var leafletDone = false, dataDone = false;

    window.loadLeaflet(function() {
      _leafletReady = true;
      leafletDone = true;
      if (dataDone) _tryRender();
    });

    fetch('/api/' + slug + '/venues?all=1&status=confirmed')
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(venues) {
        _allVenues = venues;
        _dataReady = true;
        dataDone = true;
        if (leafletDone) _tryRender();
      })
      .catch(function() {
        var sb = document.getElementById('map-sidebar');
        if (sb) sb.innerHTML = '<p style="color:#e55;font-size:0.82rem;padding:0.5rem">Could not load venues.</p>';
        _dataReady = true;
      });
  };

  function _resize() {
    var mapEl = document.getElementById('map-view');
    if (!mapEl || mapEl.style.display === 'none') return;
    var top = mapEl.getBoundingClientRect().top;
    mapEl.style.height = Math.max(300, window.innerHeight - top) + 'px';
    if (_map) _map.invalidateSize();
  }

  window.showMap = function() {
    _resize();
  };

  window.addEventListener('resize', _resize);

  window.runBulkGeocode = function() {
    var ungeocoded = _allVenues.filter(function(v) { return !v.lat || !v.lng; });
    if (!ungeocoded.length) return;
    var btn      = document.getElementById('map-geocode-btn');
    var progress = document.getElementById('map-geocode-progress');
    var token    = sessionStorage.getItem('smartist_token');
    if (btn)      btn.disabled = true;
    if (progress) progress.style.display = '';

    var total  = ungeocoded.length;
    var done   = 0;
    var saved  = 0;
    var failed = 0;

    function _updateProgress() {
      if (!progress) return;
      var msg = (done) + ' / ' + total + ' processed — ' + saved + ' saved';
      if (failed) msg += ', ' + failed + ' failed';
      progress.textContent = msg;
    }

    function next() {
      if (done >= total) {
        if (btn) { btn.disabled = false; btn.textContent = 'Get coordinates'; }
        if (progress) {
          var summary = saved + ' saved';
          if (failed) summary += ', ' + failed + ' failed';
          progress.textContent = 'Done: ' + summary + '.';
        }
        _renderMarkers();
        return;
      }
      var v = ungeocoded[done];
      _updateProgress();

      var query = [v.street_number, v.street, v.city, v.postcode, v.country].filter(Boolean).join(' ');
      window.geocodeAddress(query).then(function(result) {
        var afterDelay = function() { done++; next(); };
        if (!result) { failed++; setTimeout(afterDelay, 1100); return; }

        var url  = '/api/' + _slug + '/venues/' + v.id;
        var opts = { method: 'PUT', headers: { 'Content-Type': 'application/json' } };
        if (token) opts.headers['Authorization'] = 'Bearer ' + token;
        opts.body = JSON.stringify({ name: v.name, lat: result.lat, lng: result.lng });
        fetch(url, opts)
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(updated) {
            if (updated) {
              saved++;
              var idx = _allVenues.findIndex(function(x) { return x.id === v.id; });
              if (idx >= 0) _allVenues[idx] = updated;
            } else {
              failed++;
            }
            setTimeout(afterDelay, 1100);
          })
          .catch(function() { failed++; setTimeout(afterDelay, 1100); });
      });
    }
    next();
  };

}());
