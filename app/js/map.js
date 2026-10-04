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
  var _renderer   = null;
  var _layerGroup = null;
  var _slug       = '';
  var _allVenues  = [];
  var _markerData = []; // [{ venue, marker }] — built once, filtered by show/hide
  var _leafletReady  = false;
  var _dataReady     = false;
  var _confirmedOnly = true;

  var _statusFilter   = {};
  var _categoryFilter = {};
  var _sizeFilter     = 'any';
  var _textFilter     = '';

  // Lazy-load Leaflet JS once; CSS is already in <head>.
  var _leafletCallbacks = null;
  window.loadLeaflet = function (cb) {
    if (window.L) { cb(); return; }
    if (_leafletCallbacks) { _leafletCallbacks.push(cb); return; }
    _leafletCallbacks = [cb];
    var s = document.createElement('script');
    s.src = '/app/vendor/leaflet-1.9.4/leaflet.js';
    s.integrity = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';
    s.crossOrigin = 'anonymous';
    s.onload = function() {
      var cbs = _leafletCallbacks;
      _leafletCallbacks = null;
      cbs.forEach(function(f) { f(); });
    };
    document.head.appendChild(s);
  };

  // Marker clustering. The plugin extends Leaflet, so it can only load afterwards —
  // hence the chain instead of a second async tag in the page. It is optional: if it
  // fails (offline, CSP, CDN), the map falls back to a plain feature group.
  window.loadMarkerCluster = function (cb) {
    if (!window.L || L.markerClusterGroup) { cb(); return; }
    var s = document.createElement('script');
    s.src = '/app/vendor/leaflet.markercluster-1.5.3/leaflet.markercluster.js';
    s.integrity = 'sha384-eXVCORTRlv4FUUgS/xmOyr66XBVraen8ATNLMESp92FKXLAMiKkerixTiBvXriZr';
    s.crossOrigin = 'anonymous';
    s.onload  = cb;
    s.onerror = cb;
    document.head.appendChild(s);
  };

  // Grouping layer for the markers. featureGroup, not layerGroup: only the former has
  // getBounds(), which the fit-to-venues call needs.
  function _makeMarkerLayer() {
    if (window.L && L.markerClusterGroup) {
      return L.markerClusterGroup({
        chunkedLoading: true,          // ~1800 markers without freezing the page
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        maxClusterRadius: 50,
      });
    }
    return L.featureGroup();
  }

  function _markerOptions(status) {
    var color = STATUS_COLORS[(status || '').toLowerCase()] || STATUS_COLORS[''];
    return {
      renderer:    _renderer,
      radius:      6,
      color:       'rgba(0,0,0,0.3)',
      weight:      1.5,
      fillColor:   color,
      fillOpacity: 0.9,
    };
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
      if (_sizeFilter === 'small'  && (v.size == null || v.size >= 100))                return false;
      if (_sizeFilter === 'medium' && (v.size == null || v.size < 100 || v.size > 500)) return false;
      if (_sizeFilter === 'large'  && (v.size == null || v.size <= 500))                return false;
    }
    return true;
  }

  window._mapFilterText = function(val) {
    _textFilter = val.trim();
    _applyFilter();
  };

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _popup(v) {
    var color  = STATUS_COLORS[(v.status || '').toLowerCase()] || STATUS_COLORS[''];
    var status = v.status
      ? '<span style="background:' + color + ';color:#fff;padding:1px 7px;border-radius:10px;font-size:0.75rem">' + _escHtml(v.status) + '</span> '
      : '';
    var cat  = v.category ? '<div style="color:#666;font-size:0.8rem">' + _escHtml(v.category) + '</div>' : '';
    var loc  = [v.city, v.country].filter(Boolean).map(_escHtml).join(', ');
    var size = v.size ? '<div style="color:#666;font-size:0.8rem">' + t('map.popupCapacity') + ': ' + _escHtml(v.size) + '</div>' : '';
    return '<div style="min-width:140px"><strong>' + _escHtml(v.name) + '</strong>' +
      (loc ? '<div style="color:#555;font-size:0.82rem;margin:2px 0">' + loc + '</div>' : '') +
      status + cat + size +
      '<div style="margin-top:6px"><a href="#" data-onclick="event.preventDefault();openVenueFromMap(' + v.id + ')" style="font-size:0.8rem">' + t('map.popupView') + '</a></div>' +
      '</div>';
  }

  // Build circleMarker objects once from _allVenues (canvas — no DOM elements).
  function _buildMarkers() {
    _markerData = [];
    if (_layerGroup) _layerGroup.clearLayers();
    _allVenues.forEach(function(v) {
      if (!v.lat || !v.lng) return;
      var m = L.circleMarker([v.lat, v.lng], _markerOptions(v.status || ''));
      m.bindPopup(_popup(v));
      _markerData.push({ venue: v, marker: m });
    });
    _applyFilter();
  }

  // Toggle marker visibility without recreating DOM elements.
  function _applyFilter() {
    if (!_layerGroup) return;
    _layerGroup.clearLayers();
    _markerData.forEach(function(d) {
      if (_passes(d.venue)) _layerGroup.addLayer(d.marker);
    });
    _updateUnmappedCount();
  }

  function _updateUnmappedCount() {
    var noCoords = _allVenues.filter(function(v) { return !v.lat || !v.lng; }).length;
    var msgEl = document.getElementById('map-unmapped-msg');
    var secEl = document.getElementById('map-geocode-section');
    if (msgEl) msgEl.textContent = noCoords > 0
      ? t(noCoords !== 1 ? 'map.notOnMap_other' : 'map.notOnMap_one', { n: noCoords })
      : '';
    if (secEl) secEl.style.display = noCoords > 0 ? '' : 'none';
  }

  function _buildSidebar() {
    var sb = document.getElementById('map-sidebar');
    if (!sb) return;

    var statusHtml = '<div class="map-filter-label">' + t('map.filterStatus') + '</div>';
    window.VENUE_STATUSES.forEach(function(s) {
      _statusFilter[s.value] = true;
      statusHtml += '<label class="map-filter-row">' +
        '<input type="checkbox" checked data-onchange="window._mapFilterStatus(\'' + s.value + '\',this.checked)">' +
        '<span class="map-legend-dot" style="background:' + (STATUS_COLORS[s.value] || STATUS_COLORS['']) + '"></span>' +
        _escHtml(s.label) + '</label>';
    });
    _statusFilter[''] = true;

    var catHtml = '<div class="map-filter-label">' + t('map.filterCategory') + '</div>';
    window.VENUE_CATEGORIES.forEach(function(c) {
      _categoryFilter[c.value] = true;
      catHtml += '<label class="map-filter-row">' +
        '<input type="checkbox" checked data-onchange="window._mapFilterCategory(\'' + c.value + '\',this.checked)">' +
        _escHtml(c.label) + '</label>';
    });
    _categoryFilter[''] = true;

    var sizeHtml = '<div class="map-filter-label">' + t('map.filterSize') + '</div>' +
      '<div class="map-size-btns">' +
      '<button class="map-size-btn active" data-size="any"    data-onclick="window._mapFilterSize(\'any\')">' + t('map.sizeAny') + '</button>' +
      '<button class="map-size-btn"        data-size="small"  data-onclick="window._mapFilterSize(\'small\')">&lt;100</button>' +
      '<button class="map-size-btn"        data-size="medium" data-onclick="window._mapFilterSize(\'medium\')" style="font-size:0.73rem">100–500</button>' +
      '<button class="map-size-btn"        data-size="large"  data-onclick="window._mapFilterSize(\'large\')">&gt;500</button>' +
      '</div>';

    var geocodeHtml =
      '<div id="map-geocode-section" style="display:none;margin-top:0.75rem">' +
      '<button id="map-geocode-btn" class="btn active" data-onclick="window.runBulkGeocode()">' + t('map.geocodeBtn') + '</button>' +
      '<div id="map-geocode-progress" style="display:none;font-size:0.75rem;color:var(--third-color);margin-top:0.3rem"></div>' +
      '<div id="map-unmapped-msg" style="font-size:0.75rem;color:var(--third-color);margin-top:0.3rem"></div>' +
      '</div>';

    var scopeHtml =
      '<div class="map-filter-label" style="margin-top:0">Show</div>' +
      '<div style="display:flex;flex-direction:column;gap:0.2rem;margin-bottom:0.5rem">' +
        '<label class="map-filter-row" style="cursor:pointer">' +
          '<input type="radio" name="map-scope" value="confirmed" ' + (_confirmedOnly ? 'checked' : '') + ' data-onchange="window._mapScopeChange(this.value)"> ' + t('map.scopeConfirmed') + '</label>' +
        '<label class="map-filter-row" style="cursor:pointer">' +
          '<input type="radio" name="map-scope" value="all" ' + (!_confirmedOnly ? 'checked' : '') + ' data-onchange="window._mapScopeChange(this.value)"> ' + t('map.scopeAll') + '</label>' +
      '</div>' +
      '<button id="map-load-btn" class="btn active" data-onclick="window._mapLoad()" style="width:100%;margin-bottom:0.75rem;font-size:0.78rem;padding:0.35rem 0.5rem">' + t('map.loadBtn') + '</button>';

    sb.innerHTML = scopeHtml + statusHtml + catHtml + sizeHtml + geocodeHtml;
  }

  window._mapScopeChange = function(val) {
    _confirmedOnly = (val === 'confirmed');
  };

  window._mapLoad = function() {
    var btn = document.getElementById('map-load-btn');
    if (btn) { btn.disabled = true; btn.textContent = t('map.loading'); }
    _dataReady = false;
    _allVenues = [];
    var url = '/api/' + _slug + '/venues?all=1' + (_confirmedOnly ? '&status=confirmed' : '');
    apiFetch(url)
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(venues) {
        _allVenues = venues;
        _dataReady = true;
        _buildSidebar();
        _buildMarkers();
        _fitToMarkers();
      })
      .catch(function() {
        if (btn) { btn.disabled = false; btn.textContent = t('map.loadBtn'); }
      });
  };

  window._mapFilterStatus = function(val, checked) {
    _statusFilter[val] = checked;
    _applyFilter();
  };
  window._mapFilterCategory = function(val, checked) {
    _categoryFilter[val] = checked;
    _applyFilter();
  };
  window._mapFilterSize = function(val) {
    _sizeFilter = val;
    document.querySelectorAll('.map-size-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.size === val);
    });
    _applyFilter();
  };

  function _initLeafletMap() {
    var canvas = document.getElementById('map-canvas');
    if (!canvas || _map) return;
    _renderer   = L.canvas({ padding: 0.5 });
    _layerGroup = _makeMarkerLayer();
    _map = L.map(canvas, { zoomControl: true, preferCanvas: true }).setView([48.5, 9.0], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(_map);
    _layerGroup.addTo(_map);
  }

  // Zoom to the venues that are actually on the map; a group with no markers has no
  // valid bounds, so the default view stays.
  function _fitToMarkers() {
    if (!_map || !_layerGroup || typeof _layerGroup.getBounds !== 'function') return;
    var bounds = _layerGroup.getBounds();
    if (bounds && bounds.isValid()) _map.fitBounds(bounds.pad(0.2));
  }

  function _tryRender() {
    if (!_leafletReady || !_dataReady) return;
    _initLeafletMap();
    _buildSidebar();
    _buildMarkers();
    _fitToMarkers();
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { if (_map) _map.invalidateSize(); });
    });
  }

  window.initMap = function(slug) {
    _slug = slug;
    var leafletDone = false, dataDone = false;

    window.loadLeaflet(function() {
      window.loadMarkerCluster(function() {
        _leafletReady = true;
        leafletDone = true;
        if (dataDone) _tryRender();
      });
    });

    apiFetch('/api/' + slug + '/venues?all=1&status=confirmed')
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(venues) {
        _allVenues = venues;
        _dataReady = true;
        dataDone = true;
        if (leafletDone) _tryRender();
      })
      .catch(function() {
        _allVenues = [];
        _dataReady = true;
        dataDone = true;
        if (leafletDone) _tryRender();
      });
  };

  function _resize() {
    var mapEl = document.getElementById('map-view');
    if (!mapEl || mapEl.style.display === 'none') return;
    if (_map) _map.invalidateSize();
  }

  window.showMap = function() {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { if (_map) _map.invalidateSize(); });
    });
  };

  window.addEventListener('resize', _resize);

  window.runBulkGeocode = function() {
    var ungeocoded = _allVenues.filter(function(v) { return !v.lat || !v.lng; });
    if (!ungeocoded.length) return;
    var btn      = document.getElementById('map-geocode-btn');
    var progress = document.getElementById('map-geocode-progress');
    var token    = sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token');
    if (btn)      btn.disabled = true;
    if (progress) progress.style.display = '';

    var total  = ungeocoded.length;
    var done   = 0;
    var saved  = 0;
    var failed = 0;

    function _updateProgress() {
      if (!progress) return;
      var msg = t('map.geocodeProgress', { done: done, total: total, saved: saved });
      if (failed) msg += t('map.geocodeFailed', { failed: failed });
      progress.textContent = msg;
    }

    function next() {
      if (done >= total) {
        if (btn) { btn.disabled = false; btn.textContent = t('map.geocodeBtn'); }
        if (progress) {
          progress.textContent = failed
            ? t('map.geocodeDoneFailed', { saved: saved, failed: failed })
            : t('map.geocodeDone', { saved: saved });
        }
        _buildMarkers();
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

  // SPA navigation with a cached config resolves loadConfig() as a microtask, causing
  // venues.js's initPage callback to run before this script executes. In that case
  // window.initMap was undefined when the callback checked it, so the slug was stored
  // in _pendingMapSlug for us to pick up here.
  if (window._pendingMapSlug) {
    var _pendingSlug = window._pendingMapSlug;
    delete window._pendingMapSlug;
    window.initMap(_pendingSlug);
  }

}());
