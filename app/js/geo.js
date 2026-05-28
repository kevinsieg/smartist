(function () {
  'use strict';

  // ISO 3166-1 English short names
  var COUNTRIES = [
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola',
    'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia', 'Austria',
    'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados',
    'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
    'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei',
    'Bulgaria', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia',
    'Cameroon', 'Canada', 'Central African Republic', 'Chad', 'Chile',
    'China', 'Colombia', 'Comoros', 'Congo', 'Costa Rica',
    "Côte d'Ivoire", 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic',
    'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
    'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador',
    'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia',
    'Fiji', 'Finland', 'France', 'Gabon', 'Gambia',
    'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada',
    'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti',
    'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia',
    'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
    'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya',
    'Kiribati', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia',
    'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein',
    'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia',
    'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania',
    'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco',
    'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar',
    'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand',
    'Nicaragua', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia',
    'Norway', 'Oman', 'Pakistan', 'Palau', 'Panama',
    'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland',
    'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda',
    'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines',
    'Samoa', 'San Marino', 'São Tomé and Príncipe', 'Saudi Arabia',
    'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore',
    'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa',
    'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan',
    'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan',
    'Tajikistan', 'Tanzania', 'Thailand', 'Timor-Leste', 'Togo',
    'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan',
    'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates',
    'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan',
    'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen',
    'Zambia', 'Zimbabwe',
  ];

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function isFrance(countryEl) {
    return (countryEl.value || '').trim().toLowerCase() === 'france';
  }

  // BAN (Base Adresse Nationale) — France only, keyless, 50 req/s
  // Returns municipality suggestions with postcode + département context.
  function fetchBAN(q, callback) {
    var qs = new URLSearchParams({ q: q, type: 'municipality', limit: '6' });
    fetch('https://api-adresse.data.gouv.fr/search/?' + qs)
      .then(function (r) { return r.ok ? r.json() : { features: [] }; })
      .then(function (data) {
        var suggestions = {};
        var seen = {};
        var opts = [];
        (data.features || []).forEach(function (f) {
          var p       = f.properties || {};
          var city    = p.city || p.name;
          var postcode = p.postcode || '';
          var context = p.context || ''; // e.g. "95, Val-d'Oise, Île-de-France"
          if (!city) return;
          // Show postcode + département context in the suggestion
          var hint  = [postcode, context.split(',')[1] || ''].map(function (s) { return s.trim(); }).filter(Boolean).join(' · ');
          var label = hint ? city + ' (' + hint + ')' : city;
          if (seen[label]) return;
          seen[label]        = true;
          suggestions[label] = { city: city, country: 'France', postcode: postcode };
          opts.push('<option value="' + escAttr(label) + '">');
        });
        callback(suggestions, opts.join(''));
      })
      .catch(function () { callback({}, ''); });
  }

  // Nominatim (OpenStreetMap) — global fallback
  function fetchNominatim(q, callback) {
    var qs = new URLSearchParams({
      q: q, format: 'json', limit: '6', addressdetails: '1', featureType: 'city',
    });
    fetch('https://nominatim.openstreetmap.org/search?' + qs, {
      headers: { 'Accept-Language': 'en' },
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (results) {
        var suggestions = {};
        var seen = {};
        var opts = [];
        results.forEach(function (item) {
          var a    = item.address || {};
          var city = a.city || a.town || a.village || a.hamlet || item.name;
          if (!city) return;
          var country = a.country || '';
          var label   = country ? city + ', ' + country : city;
          if (seen[label]) return;
          seen[label]        = true;
          suggestions[label] = { city: city, country: country, postcode: '' };
          opts.push('<option value="' + escAttr(label) + '">');
        });
        callback(suggestions, opts.join(''));
      })
      .catch(function () { callback({}, ''); });
  }

  // Geocode an address string → Promise<{lat, lng}|null>
  // Returns null on failure, no result, or network error.
  window.geocodeAddress = function (query) {
    if (!query || !query.trim()) return Promise.resolve(null);
    var qs = new URLSearchParams({ q: query.trim(), format: 'json', limit: '1', addressdetails: '0' });
    return fetch('https://nominatim.openstreetmap.org/search?' + qs, {
      headers: { 'Accept-Language': 'en' },
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (results) {
        if (!results.length) return null;
        return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
      })
      .catch(function () { return null; });
  };

  // Attach country datalist + city autocomplete (BAN for France, Nominatim otherwise).
  // postcodeId is optional — when provided, BAN results auto-fill the postcode field.
  window.initGeoFields = function (cityId, countryId, postcodeId) {
    var cityEl     = document.getElementById(cityId);
    var countryEl  = document.getElementById(countryId);
    var postcodeEl = postcodeId ? document.getElementById(postcodeId) : null;
    if (!cityEl || !countryEl) return;

    // One shared country datalist per page
    var cDlId = 'geo-country-list';
    if (!document.getElementById(cDlId)) {
      var cDl = document.createElement('datalist');
      cDl.id  = cDlId;
      cDl.innerHTML = COUNTRIES.map(function (c) {
        return '<option value="' + escAttr(c) + '">';
      }).join('');
      document.body.appendChild(cDl);
    }
    countryEl.setAttribute('list', cDlId);

    // Per-input city suggestions datalist
    var sDlId = cityId + '-geo';
    if (!document.getElementById(sDlId)) {
      var sDl = document.createElement('datalist');
      sDl.id  = sDlId;
      document.body.appendChild(sDl);
    }
    cityEl.setAttribute('list', sDlId);

    var suggestions = {};
    var timer = null;

    cityEl.addEventListener('input', function () {
      clearTimeout(timer);
      var q = this.value.trim();
      if (q.length < 3) { document.getElementById(sDlId).innerHTML = ''; return; }
      var france = isFrance(countryEl);
      timer = setTimeout(function () {
        var fetch = france ? fetchBAN : fetchNominatim;
        fetch(q, function (s, html) {
          suggestions = s;
          document.getElementById(sDlId).innerHTML = html;
        });
      }, 400);
    });

    // Re-run autocomplete when country changes (so switching to France upgrades to BAN)
    countryEl.addEventListener('change', function () {
      if (cityEl.value.trim().length >= 3) cityEl.dispatchEvent(new Event('input'));
    });

    // On selection: strip hint suffix → city only; auto-fill country + postcode
    cityEl.addEventListener('change', function () {
      var entry = suggestions[this.value.trim()];
      if (!entry) return;
      document.getElementById(sDlId).innerHTML = '';
      this.value = entry.city;
      if (entry.country && !countryEl.value.trim()) countryEl.value = entry.country;
      if (postcodeEl && entry.postcode && !postcodeEl.value.trim()) postcodeEl.value = entry.postcode;
    });
  };

  window.COUNTRIES = COUNTRIES;
}());
