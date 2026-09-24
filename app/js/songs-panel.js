// Song side panel: the read view, the edit form and the new-song flow.
// Split out of songs.js — same global scope, loaded before it. Uses songs, getVal,
// artistSlug and the media/lyrics helpers.
// SPA rule applies here too: no top-level const/let (see tests/unit/page_scripts.js).

function _openSongPanelContent(item, panelEl) {
  var song = songs.find(function(s) { return String(s.id) === String(item.id); });
  if (!song) return;
  var sid = String(song.id);

  var title = escHtml(song.title || t('songs.untitled'));
  var activeDot = song.active
    ? '<span class="vsp-active-dot vsp-active-dot--on">&#9679; ' + t('songs.active') + '</span>'
    : '<span class="vsp-active-dot vsp-active-dot--off">&#9679; ' + t('songs.inactive') + '</span>';

  var listenUrl   = getVal(song, 'extra.listenUrl');
  var playbackUrl = getVal(song, 'extra.playbackUrl');
  var lyricsVal   = String(getVal(song, 'extra.lyrics') || '').trim();
  var sheetUrl    = getVal(song, 'extra.sheetUrl');
  var sidEsc      = escHtml(sid);
  var audioRe     = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

  var _spd = '<div class="audio-speed-btns"><button onclick="_setAudioSpeed(this,0.7)">0.7×</button><button onclick="_setAudioSpeed(this,0.8)">0.8×</button><button onclick="_setAudioSpeed(this,0.9)">0.9×</button></div>';
  var audioHtml = '';
  if (listenUrl  && audioRe.test(listenUrl))
    audioHtml += '<div class="vsp-audio-block"><div class="vsp-audio-label">&#9654; ' + t('songs.listen') + '</div><audio class="vsp-audio" controls src="' + escHtml(safeUrl(listenUrl)) + '"></audio>' + _spd + '</div>';
  if (playbackUrl && audioRe.test(playbackUrl))
    audioHtml += '<div class="vsp-audio-block"><div class="vsp-audio-label">&#9655; ' + t('songs.playback') + '</div><audio class="vsp-audio" controls src="' + escHtml(safeUrl(playbackUrl)) + '"></audio>' + _spd + '</div>';

  var actions = '';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="' + t('songs.editSong') + '" onclick="_openSongEditForm(\'' + sidEsc + '\', document.getElementById(\'view-side-panel-inner\'))">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/>' +
    '</svg></button>';
  actions += '<a class="btn icon-btn" data-tooltip="' + t('songs.stageView') + '" href="/' + _artistSlug + '/stage?song=' + sidEsc + '" target="_blank" rel="noopener">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/>' +
    '</svg></a>';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="' + t('songs.lyricsTitle') + '" onclick="openLyrics(\'' + sidEsc + '\')">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/>' +
    '</svg></button>';
  if (listenUrl  && !audioRe.test(listenUrl))   actions += '<button class="btn" onclick="openPlayer(\'' + sidEsc + '\')">&#9654; ' + t('songs.listen') + '</button>';
  if (playbackUrl && !audioRe.test(playbackUrl)) actions += '<button class="btn" onclick="openPlayback(\'' + sidEsc + '\')">&#9655; ' + t('songs.playback') + '</button>';
  if (sheetUrl)   actions += '<button class="btn" onclick="openSheet(\'' + sidEsc + '\')">&#8801; ' + t('songs.sheet') + '</button>';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="' + t('songs.colTitleArrangement') + '" onclick="_openSongArrangement(' + Number(sid) + ')">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/>' +
    '</svg></button>';

  var key     = getVal(song, 'key');
  var energy  = getVal(song, 'energy');
  var timeSig = getVal(song, 'time_signature');
  var bpm     = getVal(song, 'bpm');
  var len     = minsToTime(getVal(song, 'length_min'));
  var lead    = getVal(song, 'extra.lead');
  var gitCapo = getVal(song, 'extra.gitCapo');
  var bjCapo  = getVal(song, 'extra.banjoCapo');
  var git2    = getVal(song, 'extra.git2');
  var harp    = getVal(song, 'extra.harp');
  var perfCells =
    (key     ? _vspCell(t('songs.fieldKey'),        escHtml(String(key)))     : '') +
    (energy  ? _vspCell(t('songs.fieldEnergy'),     escHtml(energyLabel(energy))) : '') +
    (timeSig ? _vspCell(t('songs.fieldTimeSig'),    escHtml(String(timeSig))) : '') +
    (bpm     ? _vspCell(t('songs.fieldBpm'),        escHtml(String(bpm)))     : '') +
    (len     ? _vspCell(t('songs.fieldLength'),     escHtml(len))             : '') +
    (lead    ? _vspCell(t('songs.fieldLead'),       escHtml(String(lead)))    : '') +
    (gitCapo ? _vspCell(t('songs.fieldGitCapo'),    escHtml(String(gitCapo))) : '') +
    (bjCapo  ? _vspCell(t('songs.fieldBanjoCapo'),  escHtml(String(bjCapo)))  : '') +
    (git2    ? _vspCell(t('songs.fieldGuitar2'),    '&#10003;')               : '') +
    (harp    ? _vspCell(t('songs.fieldHarmonica'),  '&#10003;')               : '');
  var perfHtml = perfCells ? _vspSection(t('songs.sectionPerformance'), perfCells) : '';

  var genre   = getVal(song, 'genre');
  var interp  = getVal(song, 'interpret');
  var refInt  = getVal(song, 'reference_interpret');
  var author  = getVal(song, 'extra.author');
  var comment = getVal(song, 'comment');
  var refUrl  = getVal(song, 'extra.referenceUrl');
  var infoUrl = getVal(song, 'extra.songinfoUrl');
  var aboutCells =
    (genre   ? _vspCell(t('songs.fieldGenre'),         escHtml(String(genre)))  : '') +
    (interp  ? _vspCell(t('songs.fieldInterpret'),     escHtml(String(interp))) : '') +
    (refInt  ? _vspCell(t('songs.fieldRefInterpret'),  escHtml(String(refInt))) : '') +
    (author  ? _vspCell(t('songs.fieldAuthor'),        escHtml(String(author))) : '') +
    (comment ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">' + t('songs.fieldComment') + '</div><div class="vsp-cell-value">' + escHtml(String(comment)) + '</div></div>' : '') +
    (refUrl  ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">' + t('songs.fieldReference') + '</div><div class="vsp-cell-value"><a href="' + escHtml(safeUrl(String(refUrl)))  + '" target="_blank" rel="noopener">' + escHtml(String(refUrl))  + '</a></div></div>' : '') +
    (infoUrl ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">' + t('songs.fieldSongInfo') + '</div><div class="vsp-cell-value"><a href="' + escHtml(safeUrl(String(infoUrl))) + '" target="_blank" rel="noopener">' + escHtml(String(infoUrl)) + '</a></div></div>' : '');
  var aboutHtml = aboutCells ? _vspSection(t('songs.sectionAbout'), aboutCells) : '';

  var plays    = getVal(song, 'play_count');
  var lastLive = getVal(song, 'last_played_at');
  var statsCells =
    (plays    ? _vspCell(t('songs.fieldPlays'),    escHtml(String(plays))) : '') +
    (lastLive ? _vspCell(t('songs.fieldLastLive'), escHtml(formatDate(lastLive))) : '');
  var statsHtml = statsCells ? _vspSection(t('songs.sectionStats'), statsCells) : '';

  var lang   = getVal(song, 'gema_language') || (song.extra && song.extra.language) || '';
  var gemaNr = getVal(song, 'gema_work_number');
  var iswc   = song.iswc || (song.extra && song.extra.iswc) || '';
  var isrc   = (song.extra && song.extra.isrc) || '';
  var rightsCells =
    (lang   ? _vspCell(t('songs.fieldLang'),    escHtml(String(lang)))   : '') +
    (gemaNr ? _vspCell(t('songs.fieldGemaNr'),  escHtml(String(gemaNr))) : '') +
    (iswc   ? _vspCell('ISWC',                  escHtml(String(iswc)))   : '') +
    (isrc   ? _vspCell('ISRC',                  escHtml(String(isrc)))   : '');
  var rightsHtml = rightsCells ? _vspSection(t('songs.sectionRights'), rightsCells) : '';

  var lyricsHtml = lyricsVal
    ? '<div class="vsp-section-label">' + t('songs.lyricsTitle') + '</div><div class="vsp-lyrics">' + escHtml(lyricsVal) + '</div>'
    : '';

  panelEl.innerHTML =
    '<div data-sid="' + escHtml(sid) + '">' +
    '<div class="vsp-header">' +
      '<div class="vsp-header-text">' +
        '<h3 class="vsp-title">' + title + '</h3>' + activeDot +
      '</div>' +
      '<button class="vsp-close" onclick="_songsView && _songsView.deselect()" aria-label="' + t('songs.close') + '">&#215;</button>' +
    '</div>' +
    (audioHtml || actions ? audioHtml + '<div class="vsp-actions">' + actions + '</div>' : '') +
    perfHtml + aboutHtml + statsHtml + rightsHtml +
    '<div class="vsp-cell vsp-cell--full" id="vsp-setlist-link"><span class="skeleton-line" style="width:7rem;height:0.65rem;display:inline-block;"></span></div>' +
    lyricsHtml + '</div>';

  // Async: setlist count + arrangement table — both use _panelSid for stale-panel check
  var _panelSid = sid;

  // Async: arrangement table (auth-only, active version only)
  if (!_viewMode && song.has_arrangement) {
    apiFetch('/api/' + artistSlug + '/songs/' + sid + '/arrangements')
      .then(function(r) { return r.json(); })
      .then(function(versions) {
        var active = versions.find(function(v) { return v.is_active; });
        if (!active) return;
        var panel = document.getElementById('view-side-panel-inner');
        if (!panel || !panel.querySelector('[data-sid="' + _panelSid + '"]')) return;
        var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
        var sec = document.createElement('div');
        sec.className = 'vsp-section';
        sec.innerHTML =
          '<div class="vsp-section-label">' + t('songs.colTitleArrangement') +
          (active.name && active.name !== 'Default'
            ? ' <span style="color:var(--third-color);font-size:0.72rem">' + escHtml(active.name) + '</span>'
            : '') +
          '</div>' +
          _arrReadOnlyHtml(active, arrCfg);
        panel.querySelector('[data-sid="' + _panelSid + '"]').appendChild(sec);
      })
      .catch(function() {});
  }

  // Async: setlist count
  // apiFetch, not fetch: this endpoint needs the token in a private workspace.
  apiFetch('/api/' + artistSlug + '/songs?setlists=' + sid)
    .then(function(r) { return r.ok ? r.json() : []; })
    .then(function(ids) {
      var linkEl = document.getElementById('vsp-setlist-link');
      if (!linkEl) return;
      if (!ids || !ids.length) { linkEl.textContent = t('songs.notInAnySetlist'); return; }
      var songTitle = song.title || '';
      linkEl.innerHTML = '<a href="#" onclick="event.preventDefault();openAppearances(' + Number(sid) + ')" style="color:var(--secondary-ink)">&#8594; ' + t('songs.setlistCount', { count: ids.length }) + '</a>';
    })
    .catch(function() {
      var linkEl = document.getElementById('vsp-setlist-link');
      if (linkEl) linkEl.textContent = '';
    });
}

function _openSongEditForm(sid, panelEl) {
  var isNew = sid === null;
  var song  = isNew ? { extra: {}, active: true } : songs.find(function(s) { return String(s.id) === String(sid); });
  if (!song && !isNew) return;

  var id = isNew ? ('_new_panel_' + Date.now()) : String(sid);

  var title    = escHtml(getVal(song, 'title') || '');
  var active   = song.active ? ' checked' : '';
  var heart    = song.heart  ? ' checked' : '';
  var genre    = escHtml(getVal(song, 'genre') || '');
  var energy   = escHtml(getVal(song, 'energy') || '');
  var timeSig  = escHtml(getVal(song, 'time_signature') || '');
  var bpm      = escHtml(String(getVal(song, 'bpm') || ''));
  var length   = escHtml(minsToTime(getVal(song, 'length_min')));
  var lead     = escHtml(getVal(song, 'extra.lead') || '');
  var git2     = getVal(song, 'extra.git2') ? ' checked' : '';
  var gitCapo  = escHtml(String(getVal(song, 'extra.gitCapo') || ''));
  var bjCapo   = escHtml(String(getVal(song, 'extra.banjoCapo') || ''));
  var harp     = getVal(song, 'extra.harp') ? ' checked' : '';
  var listen   = escHtml(getVal(song, 'extra.listenUrl') || '');
  var sheet    = escHtml(getVal(song, 'extra.sheetUrl') || '');
  var playback = escHtml(getVal(song, 'extra.playbackUrl') || '');
  var author   = escHtml(getVal(song, 'extra.author') || '');
  var interp   = escHtml(getVal(song, 'interpret') || '');
  var refInt   = escHtml(getVal(song, 'reference_interpret') || '');
  var refUrl   = escHtml(getVal(song, 'extra.referenceUrl') || '');
  var infoUrl  = escHtml(getVal(song, 'extra.songinfoUrl') || '');
  var comment  = escHtml(getVal(song, 'comment') || '');
  var lang     = (song.extra && song.extra.language) ? song.extra.language : 'EN';
  var iswc     = song.iswc || (song.extra && song.extra.iswc) || '';
  var gemaNr   = song.gema_work_number || '';
  var isrc     = (song.extra && song.extra.isrc) || '';

  var inp = function(key, val, type) {
    type = type || 'text';
    return '<input type="' + type + '" class="edit-input" data-id="' + id + '" data-key="' + key + '" value="' + val + '" oninput="markPanelEditDirty()">';
  };
  var num = function(key, val) {
    return '<input type="number" class="edit-input" data-id="' + id + '" data-key="' + key + '" value="' + val + '" min="0" step="1" inputmode="numeric" oninput="markPanelEditDirty()">';
  };
  var chk = function(key, checked) {
    return '<input type="checkbox" data-id="' + id + '" data-key="' + key + '"' + checked + ' onchange="markPanelEditDirty()">';
  };
  // Media row: URL field + ↑ upload. Existing songs upload immediately; new
  // songs stage the file and upload on save (no song id exists yet).
  var mediaRow = function(label, key, fileId, accept, type, urlVal) {
    var onchange = isNew
      ? '_panelStageFile(this,\'' + type + '\',\'' + id + '\')'
      : '_panelUploadHandler(this,\'' + id + '\',\'' + type + '\')';
    return _editField(label,
      '<div class="panel-file-row">' + inp(key, urlVal) +
        '<button type="button" class="btn panel-upload-btn" onclick="_panelUploadFile(\'' + fileId + '\')">&#8593;</button>' +
        '<input type="file" id="' + fileId + '" style="display:none" accept="' + accept + '" onchange="' + onchange + '">' +
      '</div>' +
      '<div class="panel-file-staged" id="staged-' + type + '-' + id + '" style="display:none;font-size:0.72rem;color:var(--third-color);margin-top:0.2rem"></div>');
  };

  var langOpts = GEMA_LANGUAGES.map(function(o) {
    return '<option value="' + o + '"' + (o === lang ? ' selected' : '') + '>' + o + '</option>';
  }).join('');

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h3 class="vsp-title">' + (isNew ? t('songs.newSong') : escHtml(song.title || t('songs.editSong'))) + '</h3></div>' +
      (!isNew ? '<button class="vsp-close" onclick="_openSongPanelContent({id:' + sid + '}, document.getElementById(\'view-side-panel-inner\'))" aria-label="' + t('songs.cancel') + '">&#215;</button>' : '') +
    '</div>' +
    '<div style="padding:0 0.5rem;" data-sid="' + id + '">' +
      '<details class="edit-section" open><summary class="edit-section-summary">' + t('songs.sectionBasics') + '</summary>' +
        '<div class="edit-section-body">' +
          _editField(t('songs.fieldTitle'), '<input type="text" class="edit-input" data-id="' + id + '" data-key="title" value="' + title + '" oninput="markPanelEditDirty()" placeholder="' + t('songs.songTitlePlaceholder') + '">') +
          _editField(t('songs.fieldKey'), '<select class="edit-input" data-id="' + id + '" data-key="key" onchange="markPanelEditDirty()">' + _keyOptions(getVal(song, 'key')) + '</select>') +
          _editField(t('songs.fieldGitCapo'), num('extra.gitCapo', gitCapo)) +
          _editField(t('songs.fieldBanjoCapo'), num('extra.banjoCapo', bjCapo)) +
          _editField(t('songs.fieldBpm'), num('bpm', bpm)) +
          _editField(t('songs.fieldTimeSig'), '<select class="edit-input" data-id="' + id + '" data-key="time_signature" onchange="markPanelEditDirty()"><option value="">—</option>' + TIME_SIGNATURES.map(function(v){return '<option value="'+v+'"'+(timeSig===v?' selected':'')+'>'+v+'</option>';}).join('') + '</select>') +
          _editField(t('songs.fieldLengthMmss'), '<input type="text" class="edit-input" data-id="' + id + '" data-key="length_min" data-type="time" value="' + length + '" placeholder="MM:SS" oninput="markPanelEditDirty()">') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.sectionRecordings') + '</summary>' +
        '<div class="edit-section-body">' +
          mediaRow(t('songs.listen'),   'extra.listenUrl',   'pf-audio-' + id,    'audio/*',              'audio',    listen) +
          mediaRow(t('songs.sheet'),    'extra.sheetUrl',    'pf-sheet-' + id,    '.pdf,application/pdf', 'sheet',    sheet) +
          mediaRow(t('songs.playback'), 'extra.playbackUrl', 'pf-playback-' + id, 'audio/*',              'playback', playback) +
          _editField(t('songs.fieldRefUrl'), inp('extra.referenceUrl', refUrl, 'url')) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.lyricsTitle') + '</summary>' +
        '<div class="edit-section-body">' +
          '<button type="button" class="btn" onclick="_openLyricsFromPanel(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')">' + t('songs.openLyricsEditor') + '</button>' +
          (isNew ? '<input type="hidden" data-id="' + id + '" data-key="extra.lyrics" value="">' : '') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.sectionSongInfo') + '</summary>' +
        '<div class="edit-section-body">' +
          _editField('', '<div class="edit-toggle-row"><span>' + t('songs.active') + '</span><div class="toggle-switch"><input type="checkbox" data-id="' + id + '" data-key="active"' + active + ' onchange="markPanelEditDirty()"><span class="toggle-track"><span class="toggle-thumb"></span></span></div></div>') +
          _editField('', '<div class="edit-check-row">' + chk('heart', heart) + '<span>&#9829; ' + t('songs.favouriteHint') + '</span></div>') +
          _editField(t('songs.fieldGenre'), inp('genre', genre)) +
          _editField(t('songs.fieldEnergy'), inp('energy', energy)) +
          _editField(t('songs.fieldLanguage'), '<select class="edit-select edit-input" data-id="' + id + '" data-key="extra.language" onchange="markPanelEditDirty()">' + langOpts + '</select>') +
          _editField(t('songs.fieldLead'), inp('extra.lead', lead)) +
          _editField('', '<div class="edit-check-row">' + chk('extra.git2', git2) + '<span>' + t('songs.fieldGuitar2') + '</span></div>') +
          _editField('', '<div class="edit-check-row">' + chk('extra.harp', harp) + '<span>' + t('songs.fieldHarmonica') + '</span></div>') +
          _editField(t('songs.fieldRefInterpret'), inp('reference_interpret', refInt)) +
          _editField(t('songs.fieldSongInfoUrl'), inp('extra.songinfoUrl', infoUrl, 'url')) +
          _editField(t('songs.fieldComment'), inp('comment', comment)) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.sectionRights') + '</summary>' +
        '<div class="edit-section-body">' +
          _editField(t('songs.fieldAuthor'), inp('extra.author', author)) +
          _editField(t('songs.fieldInterpret'), inp('interpret', interp)) +
          _editField('ISWC',    '<div class="edit-readonly">' + escHtml(iswc   || '—') + '</div>') +
          _editField('GEMA-Nr', '<div class="edit-readonly">' + escHtml(gemaNr || '—') + '</div>') +
          _editField('ISRC',    '<div class="edit-readonly">' + escHtml(isrc   || '—') + '</div>') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.colTitleArrangement') + '</summary>' +
        '<div class="edit-section-body">' +
          (!isNew ? '<div id="edit-arr-preview"></div>' : '') +
          '<button class="btn" style="margin-top:0.4rem" onclick="_openArrFromPanel(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')">' + t('songs.openArrEditor') + '</button>' +
          (isNew ? '<div class="panel-file-staged" id="staged-arr-' + id + '" style="display:none;font-size:0.72rem;color:var(--third-color);margin-top:0.4rem"></div>' : '') +
        '</div>' +
      '</details>' +
      '<div class="status-msg" id="song-panel-edit-error"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active auth-action" id="song-panel-save-btn" onclick="_savePanelSong(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')" disabled>' + (isNew ? t('songs.add') : t('songs.save')) + '</button>' +
        (!isNew ? '<button class="btn" onclick="_songsView && _songsView.select(\'' + sid + '\')">' + t('songs.cancel') + '</button>' : '') +
      '</div>' +
    '</div>';

  var titleInput = panelEl.querySelector('input[data-key="title"]');
  if (titleInput) titleInput.focus();

  if (!isNew && song.has_arrangement) {
    var _editArrSid = String(sid);
    var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
    apiFetch('/api/' + artistSlug + '/songs/' + _editArrSid + '/arrangements')
      .then(function(r) { return r.json(); })
      .then(function(versions) {
        var active = versions.find(function(v) { return v.is_active; });
        if (!active) return;
        var preview = document.getElementById('edit-arr-preview');
        if (!preview || !panelEl.querySelector('[data-sid="' + _editArrSid + '"]')) return;
        preview.innerHTML = _arrReadOnlyHtml(active, arrCfg);
      })
      .catch(function() {});
  }
}

// New-song file picks are deferred: stash the File in its hidden input and show
// the filename. The actual upload happens in _commitNewSong, once the song has
// an id. (Existing songs upload immediately via _panelUploadHandler.)
function _panelStageFile(input, type, id) {
  var file = input.files[0];
  if (!file) return;
  var maxBytes = type === 'sheet' ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) { input.value = ''; _setBulkStatus('error', t('songs.fileTooLarge')); return; }
  var label = document.getElementById('staged-' + type + '-' + id);
  if (label) { label.textContent = '✓ ' + t('songs.willUploadOnSave', { name: file.name }); label.style.display = ''; }
  markPanelEditDirty();
}

// Create a song from the panel, then upload any files staged on its inputs.
// Returns the created song, or null if it couldn't be created (no title / auth).
async function _commitNewSong(formId) {
  var token = getToken();
  if (!token) { if (!isViewMode()) requireLogin(); return null; }

  var bad = [].slice.call(document.querySelectorAll('input[type="number"][data-id="' + formId + '"]'))
    .find(function(i) { return !i.checkValidity(); });
  if (bad) { bad.reportValidity(); bad.focus(); return null; }

  var data = collectRow(formId);
  if (!data.title) {
    var titleInput = document.querySelector('input[data-key="title"][data-id="' + formId + '"]');
    if (titleInput) titleInput.focus();
    return null;
  }

  var r = await fetch('/api/' + artistSlug + '/songs', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body:    JSON.stringify(data),
  });
  if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } return null; }
  if (!r.ok) throw new Error('create failed');
  var newSong = await r.json();

  var staged = [['audio', 'pf-audio-'], ['sheet', 'pf-sheet-'], ['playback', 'pf-playback-']];
  for (var i = 0; i < staged.length; i++) {
    var inputEl = document.getElementById(staged[i][1] + formId);
    var file = inputEl && inputEl.files[0];
    if (!file) continue;
    try { await _uploadSongMedia(newSong.id, staged[i][0], file); }
    catch (err) { if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed')); }
  }

  // Persist a draft arrangement entered before the song existed, then activate it.
  var draft = _pendingArrDrafts[formId];
  if (draft) {
    try {
      var ar = await fetch('/api/' + artistSlug + '/songs/' + newSong.id + '/arrangements', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify({ name: 'Default', rows: draft.rows, hidden_instruments: draft.hidden_instruments }),
      });
      if (ar.ok) {
        var created = await ar.json();
        await fetch('/api/' + artistSlug + '/songs/' + newSong.id + '/arrangements/' + created.id + '/activate', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + token },
        });
      }
    } catch (e) { /* song is saved; arrangement just didn't attach */ }
    delete _pendingArrDrafts[formId];
  }
  return newSong;
}

async function _savePanelSong(formId, isNew, realSid) {
  var token = getToken();
  if (!token) { if (!isViewMode()) requireLogin(); return; }

  var bad = [].slice.call(document.querySelectorAll('input[type="number"][data-id="' + formId + '"]'))
    .find(function(i) { return !i.checkValidity(); });
  if (bad) { bad.reportValidity(); bad.focus(); return; }

  var btn = document.getElementById('song-panel-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('songs.saving'); }

  try {
    var targetId;
    if (isNew) {
      var newSong = await _commitNewSong(formId);
      if (!newSong) { if (btn) { btn.disabled = false; btn.textContent = t('songs.add'); } return; }
      targetId = String(newSong.id);
    } else {
      var r = await fetch('/api/' + artistSlug + '/songs', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify([Object.assign({ id: parseInt(realSid, 10) }, collectRow(formId))]),
      });
      if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } return; }
      if (!r.ok) throw new Error('save failed');
      targetId = String(realSid);
    }

    // Songs ride along in the cached /api/config payload (the setlist page reads
    // cfg.songs), so drop that cache or other pages keep serving the old list.
    invalidateConfigCache();
    await fetchSongsList(true);
    if (_songsView) { _songsView.refresh(); _songsView.select(targetId); }
    loadLogs();
  } catch {
    var errEl = document.getElementById('song-panel-edit-error');
    if (errEl) { errEl.textContent = t('songs.saveFailed'); errEl.className = 'status-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = isNew ? t('songs.add') : t('songs.save'); }
  }
}

function _isNewPanelSid(sid) { return String(sid).indexOf('_new_panel_') === 0; }

// Lyrics editor. Existing songs save through the API (needs an id). A new,
// unsaved song has no id, so it opens in local mode: lyrics are held in the
// panel's hidden field and written when the song is created (see saveLyrics).
function _openLyricsFromPanel(formId, isNew, sid) {
  if (!isNew) { openLyricsEdit(sid); return; }
  currentLyricsSid = formId;
  var hidden = document.querySelector('input[data-key="extra.lyrics"][data-id="' + formId + '"]');
  document.getElementById('lyrics-title').textContent = '¶ ' + t('songs.lyricsTitle');
  document.getElementById('lyrics-edit').value        = (hidden && hidden.value) || '';
  _lyricsSetMode('edit');
  document.getElementById('lyrics-modal').classList.add('open');
  document.getElementById('lyrics-edit').focus();
}

// Arrangement editor. Existing songs edit live against the API. A new, unsaved
// song opens a single-version draft held in memory; it's persisted on Add.
function _openArrFromPanel(formId, isNew, sid) {
  if (!isNew) { _openSongArrangement(sid); return; }
  var titleInput = document.querySelector('input[data-key="title"][data-id="' + formId + '"]');
  var title  = (titleInput && titleInput.value) || t('songs.newSong');
  var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
  openArrangementEditor(null, title, arrCfg, {
    draft: _pendingArrDrafts[formId] || null,
    onDraftSave: function(draft) {
      _pendingArrDrafts[formId] = draft;
      var cue = document.getElementById('staged-arr-' + formId);
      if (cue) { cue.textContent = '✓ ' + t('songs.arrStaged'); cue.style.display = ''; }
      markPanelEditDirty();
    },
  });
}

function _openNewSongPanel() {
  var panel = document.getElementById('view-side-panel');
  var inner = document.getElementById('view-side-panel-inner');
  if (!panel || !inner) return;

  var prev = document.querySelector('.lv-row--selected');
  if (prev) prev.classList.remove('lv-row--selected');

  _openSongEditForm(null, inner);
  panel.classList.add('open');
  document.getElementById('page-content').classList.add('side-panel-open');
  if (window.innerWidth <= 1024) document.body.style.overflow = 'hidden';

  if (_newPanelEscapeHandler) document.removeEventListener('keydown', _newPanelEscapeHandler);
  _newPanelEscapeHandler = function(e) {
    if (e.key === 'Escape') _closeNewSongPanel();
  };
  document.addEventListener('keydown', _newPanelEscapeHandler);
}

function _closeNewSongPanel() {
  if (_newPanelEscapeHandler) {
    document.removeEventListener('keydown', _newPanelEscapeHandler);
    _newPanelEscapeHandler = null;
  }
  var panel = document.getElementById('view-side-panel');
  if (panel) panel.classList.remove('open');
  var content = document.getElementById('page-content');
  if (content) content.classList.remove('side-panel-open');
  document.body.style.overflow = '';
}
