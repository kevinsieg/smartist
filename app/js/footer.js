// One footer for every app page, matching smartist.studio: languages left,
// donation buttons centred; on the right the way back to smartist.studio,
// Contact and the Impressum (legally required to be reachable everywhere).
// Loaded before the shared scripts; shell.js calls renderAppFooter() from injectShell();
// standalone pages (signup, onboarding, workspaces, demo) put <footer data-app-footer></footer>
// in their markup and this file fills it on load.

// Provider-agnostic: add a provider by adding an entry. An entry with an empty
// url is skipped. `img` shows the provider's own button (loaded as <img> — their
// button scripts are blocked by the CSP).
var SUPPORT_LINKS = [
  { id: 'liberapay',    label: 'Liberapay',       url: 'https://liberapay.com/kevkevkev/donate', img: 'https://liberapay.com/assets/widgets/donate.svg' },
  { id: 'buymeacoffee', label: 'Buy Me a Coffee', url: 'https://www.buymeacoffee.com/kevkevkev', img: 'https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png' },
];

var FOOTER_LOCALES = ['en', 'fr', 'de'];

// Render the non-empty SUPPORT_LINKS as external buttons into containerEl.
// Returns the number of links rendered (0 = caller should hide its group).
function renderSupportLinks(containerEl) {
  if (!containerEl) return 0;
  containerEl.textContent = '';
  var links = SUPPORT_LINKS.filter(function (l) { return l.url && l.url.trim(); });
  links.forEach(function (l) {
    var a = document.createElement('a');
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'support-link';
    if (l.img && l.img.trim()) {
      var img = document.createElement('img');
      img.src = l.img;
      img.alt = l.label;
      img.loading = 'lazy';
      a.appendChild(img);
    } else {
      a.textContent = l.label;
    }
    containerEl.appendChild(a);
  });
  return links.length;
}

function renderAppFooter(footer) {
  var current = (window.i18n && window.i18n.getLocale) ? window.i18n.getLocale() : 'en';
  footer.className = 'app-footer';
  footer.innerHTML =
    '<div class="af-lang">' + FOOTER_LOCALES.map(function (l) {
      return l === current
        ? '<strong>' + l.toUpperCase() + '</strong>'
        : '<button type="button" data-locale="' + l + '" lang="' + l + '">' + l.toUpperCase() + '</button>';
    }).join('') + '</div>' +
    '<div class="af-support" data-support-links></div>' +
    '<div class="af-legal">' +
      '<a href="https://smartist.studio">smartist.studio</a>' +
      '<a href="/contact" data-i18n="footer.contact">Contact</a>' +
      '<a href="https://smartist.studio/impressum" data-i18n="footer.impressum">Impressum</a>' +
    '</div>';
  renderSupportLinks(footer.querySelector('[data-support-links]'));
  footer.querySelectorAll('[data-locale]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (window.i18n && window.i18n.setLocale) window.i18n.setLocale(btn.getAttribute('data-locale'));
    });
  });
}

document.querySelectorAll('footer[data-app-footer]').forEach(renderAppFooter);
