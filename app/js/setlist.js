// Setlists page — shared state, init() and the tab switch between the
// generator (setlist-generator.js) and History (setlist-history-tab.js).
// Loaded last: it calls init().

var artistSlug = '';
var bandConfig = null;
var _bandName = '';
var allSongs = [];
var currentSet = [];
var _activeView = 'generator';
var _histView    = null;
var _histSets    = [];
var _histGigs    = [];
var _histGigMap  = {};   // gig.id → gig object
var _histLoaded  = false;
var _histLoadedSongs = {}; // setlistId → song array (lazy cache)
var _histPendingOpenId = null; // set after save → opened once history tab loads
var _viewMode = false;
var _editSongs   = null;
var _editingSid  = null;

// --- Init ---

async function init() {
  try {
    const cfg = await loadConfig();
    artistSlug   = cfg.slug;
    bandConfig = cfg.config ?? {};
    _bandName  = cfg.name || '';
    allSongs   = cfg.songs ?? [];
    applyNav(cfg.name, cfg.config);
    _viewMode = isViewMode();
    if (_viewMode) {
      document.body.classList.add('view-mode');
      applyViewMode();
      injectViewModeNotice();
    }
    if (cfg.config?.logoUrl) {
      const printLogo = document.querySelector('#print-header .app-logo-img');
      if (printLogo) printLogo.src = cfg.config.logoUrl.replace(/^http:/i, 'https:');
    }
    // Show tab bar and route to the correct tab
    _activeView = new URLSearchParams(location.search).get('view') || 'generator';
    var tabsEl = document.getElementById('setlist-tabs');
    if (tabsEl) {
      tabsEl.style.display = '';
      _updateTabBar();
    }
    // Compute sticky offset for tab bar (below fixed app header)
    requestAnimationFrame(function() {
      var hdr = document.querySelector('.app-header');
      if (hdr) document.documentElement.style.setProperty('--setlist-tabs-top', hdr.getBoundingClientRect().height + 'px');
    });

    onEnterSave(document.getElementById('view-side-panel-inner'), function() {
      if (_editingSid) _saveHistEdit(_editingSid);
    });

    if (_activeView === 'history') {
      document.getElementById('setlist-page-title').style.display = 'none';
      await _renderHistoryTab();
    } else {
      renderControls();
      applyDemoFilters();
    }
    injectModalCloseButtons();
  } catch {
    document.getElementById('setlist-content').innerHTML =
      '<p style="text-align:center;color:var(--third-color);">' + t('setlist.couldNotLoad') + '</p>';
  }
}

// --- Tab routing ---

function _updateTabBar() {
  document.querySelectorAll('.setlist-tab').forEach(function(t) {
    t.classList.toggle('setlist-tab--active', t.dataset.tab === _activeView);
  });
}

function switchTab(view) {
  _activeView = view;
  var _tabBase = '/' + _artistSlug + '/setlist';
  history.pushState(null, '', view === 'history' ? _tabBase + '?view=history' : _tabBase);
  _updateTabBar();
  _closeSongPanel();
  if (_histView) _histView.deselect();
  var titleEl = document.getElementById('setlist-page-title');
  if (view === 'history') {
    if (titleEl) titleEl.style.display = 'none';
    _renderHistoryTab();
  } else {
    if (titleEl) titleEl.style.display = '';
    renderControls();
    applyDemoFilters();
  }
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  _closeSongPanel();
  if (_histView) _histView.deselect();
});

init();
