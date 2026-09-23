# Google and Facebook sign-in for smartist.studio

Setting up fresh OAuth apps for the public deployment. Everything here was read
off the code, not from memory — file references included so it can be checked
if the providers change their consoles.

Until this is done, **email is the only way to create an account** on
app.smartist.studio.

---

## What the app needs

| | Value | Where it comes from |
|---|---|---|
| Redirect URI | `https://app.smartist.studio/auth/callback` | `callbackUri()` in `api/_domain/oauth.js:10`, via `/auth/callback` → `?action=oauth-callback` in `vercel.json` |
| Google scopes | `openid email` | `api/_domain/oauth.js:22` |
| Facebook scope | `email` | `api/_domain/oauth.js:38` |
| Env vars | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | `api/_domain/identity.js` |

**One redirect URI covers every entry point.** `origin()` (`api/_domain/http.js:2`)
prefers `APP_ORIGIN`, which on the `smartist` project is
`https://app.smartist.studio` — so a flow started from demo.smartist.studio
still comes back there. Nothing else needs registering.

---

## Why new apps rather than reusing salmons'

Vercel stores env vars of type **Secret** write-only. They cannot be read back
through the CLI or the dashboard:

```
! 18 Secret values cannot be pulled from the `production` Environment.
  Wrote "[SENSITIVE]" as placeholders for the remaining values
```

So the existing credentials are not recoverable from Vercel — they would have to
come out of the Google and Facebook consoles anyway. Given that, separate apps
are the better end state: the consent screen says **smartist.studio** rather
than a band's name, and revoking or rotating one deployment's credentials does
not touch the others.

---

## Google

1. **console.cloud.google.com** → create a project, e.g. `smartist-studio`
   (or reuse an existing one — the OAuth client is what matters).
2. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `smartist`, support email, developer contact
   - Authorised domain: `smartist.studio`
   - **Scopes: add none.** `openid` and `email` are non-sensitive and granted by
     default, which is why this needs **no Google verification review**. Adding
     any other scope triggers one, so do not.
   - Publishing status: **In production**. Left in *Testing*, only accounts on
     the test-user list can sign in, and tokens expire after 7 days.
3. **Credentials → Create credentials → OAuth client ID**
   - Type: **Web application**
   - Name: `smartist.studio`
   - **Authorised redirect URIs:** `https://app.smartist.studio/auth/callback`
   - Authorised JavaScript origins: leave empty — this is a server-side code
     exchange, not a browser flow.
4. Copy the **Client ID** and **Client secret**.

**Unverified addresses are rejected.** `api/_domain/identity.js:51` reads
`verified_email` from `https://www.googleapis.com/oauth2/v2/userinfo` and
returns null unless it is exactly `true`. This is deliberate: the address maps
straight onto `users` rows, so an unverified one would be a way into someone
else's workspace. If a test account cannot sign in, check that its address is
confirmed with Google before suspecting the wiring.

---

## Facebook

1. **developers.facebook.com** → Create App → type **Consumer**.
2. Add the **Facebook Login** product → **Settings**
   - **Valid OAuth Redirect URIs:** `https://app.smartist.studio/auth/callback`
   - Client OAuth Login and Web OAuth Login: on
3. **App settings → Basic**
   - App domain: `smartist.studio`
   - Privacy policy URL: required before the app can leave development mode.
     smartist.studio has an impressum but no privacy policy page — that is a
     prerequisite, not an afterthought.
4. **App Review** → make the app **Live**. In development mode only app
   administrators can sign in. `email` is a standard permission and needs no
   review, but going Live does need the privacy policy URL.
5. Copy the **App ID** and **App Secret** (Basic settings, "Show").

**Facebook addresses are not checked for verification**, unlike Google — the
code assumes Facebook only returns confirmed addresses, and that assumption has
never been verified (noted in `docs/2026-09-15` security work). It was an
acceptable risk on a single-band deployment; on a public signup surface it is
worth a second look. Consider shipping Google first and Facebook once someone
has confirmed the assumption holds.

---

## Setting the variables

```bash
vercel env add GOOGLE_CLIENT_ID production --project smartist
vercel env add GOOGLE_CLIENT_SECRET production --project smartist
vercel env add FACEBOOK_APP_ID production --project smartist
vercel env add FACEBOOK_APP_SECRET production --project smartist
```

Each prompts for the value without echoing it.

**Then redeploy.** Vercel bakes env vars into the build, so a variable added to
a live deployment changes nothing until it is rebuilt. This cost us twice on
2026-09-22 — once with `APP_SECRET`, once with the Resend key:

```bash
vercel ls smartist                    # take the Production row's URL
vercel redeploy <that-url>
```

---

## Verifying

```bash
curl -s https://app.smartist.studio/api/config | grep -o '"googleLogin":[a-z]*'
curl -s https://app.smartist.studio/api/config | grep -o '"facebookLogin":[a-z]*'
```

Both must be `true`. The flags are computed from the presence of *both*
variables per provider (`api/config.js`), and the buttons render off them —
`signup.js` asks the config first and only requests a provider URL for what is
configured, so a half-set provider shows no button rather than a broken one.

Then, in a browser: app.smartist.studio/signup should show both buttons, and a
full sign-in should land on `/onboarding` for a new address or the workspace
dashboard for an existing one.

If a button appears but the flow fails, the answer is in the logs rather than
the browser:

```bash
vercel inspect https://app.smartist.studio      # deployment id
```

then the Vercel MCP `get_runtime_logs` with that id. Note that a crash at module
load leaves nothing in the runtime *errors* view — only the logs show it.

---

## Open afterwards

- The four variables exist only on the `smartist` project. klang and salmons
  keep their own, and `smartist-website` needs none.
- If the consent screen should say something other than "smartist", it is the
  OAuth consent screen app name, editable at any time.

---

## What Meta's documentation actually says (read 2026-09-23)

The open item this doc inherited was "Facebook addresses are trusted without the
verification check Google gets — the assumption has never been verified." It has
now been checked against Meta's current documentation, page by page. The answer
is more nuanced than either "safe" or "broken".

**There is no per-request verification field.** Google's userinfo returns
`verified_email`, which `identity.js` requires to be exactly `true`. Facebook's
Graph API has no equivalent. The complete statement Meta makes about the field,
on the current User node reference, is:

> "The User's primary email address listed on their profile. This field will not
> be returned if no valid email address is available."

"Valid", not "confirmed" — and that sentence has not changed in eleven years.

**But Meta documents the pattern we implement.** The Facebook Login overview,
under *Works Alongside Your Existing Account System*:

> "Where an email address you get from Facebook Login matches one already in your
> system, you can log that person into their existing account without additional
> passwords."

That is precisely what `oauth.js` does. So this is a vendor-sanctioned pattern,
not an undocumented assumption — which is a different posture from what the
previous note implied. It is product prose rather than a security contract, and
it sits alongside Meta's bug-bounty position that unconfirmed contact points can
exist on an account and are intended functionality. Sanctioned, not guaranteed.

**Conclusion: keep Facebook login, revisit if the threat model changes.** The
practical bar here is the one the rest of the industry uses.

### If a real verification signal is ever needed

Facebook supports the OIDC Authorization Code flow with PKCE (`scope=openid`),
which returns an `id_token` JWT alongside the access token. If that JWT carries
the standard OIDC `email_verified` claim, the Facebook branch could be made
symmetric with the Google one.

Two caveats before anyone reaches for this:

- **Meta does not document the claim list.** Four pages were checked — the manual
  OIDC flow, the Limited Login token page, its validating page, and the iOS page.
  The validating doc names only `exp`, `iss`, `aud` and `nonce`. Whether
  `email_verified` is present can only be settled empirically: run a real login
  with `scope=openid` and decode the returned `id_token`.
- **The OIDC flow page is marked "still in testing".**

The heavier alternative is provider-link columns on `users` (identify by
`facebook:<id>`, confirm the address once by email). Note that Facebook user IDs
are **app-scoped**: separate Facebook apps per deployment means the same person
has a different ID on each. Since salb and klang share the `smartist-kevin`
database, that would put two different IDs for one person in one database.

---

## Code items found against Meta's security guidance

Three gaps between `api/_domain/identity.js` / `oauth.js` and the current docs.

**1. `appsecret_proof` is missing.** Meta's security checklist lists "Sign all
server-to-server Graph API calls with your App Secret" as a minimum, and three
separate pages repeat it. Our `/me?fields=email` call sends only the access
token. The documented form is timestamped:

```
hash_hmac('sha256', $access_token.'|'.time(), $app_secret)
```

sent as `appsecret_proof` plus `appsecret_time`, valid five minutes, generated
inline per call. The token-exchange call needs nothing — it is already
authenticated by `client_secret`.

**2. The Graph API version is stale.** We pin `v18.0` in two places
(`identity.js` token exchange, `oauth.js` dialog URL) and the `/me` call carries
**no version at all**, so it resolves to the oldest version still live and drifts
without any code change. Current is **v25.0**; Meta's own guidance is "unless you
have a specific reason to use an older version, specify the most recent version".

**3. `auth_type=rerequest` is missing — this one is a live bug.** `email` is the
only permission we request and the whole login depends on it. Meta:

> "once someone has declined a permission, the Login Dialog will not re-ask them
> for it unless you explicitly tell the dialog you're re-asking"

So a user who unticks email once is locked out permanently: Facebook returns no
address, `oauthCallback` fails with `no_email_from_provider`, and every retry
shows the same generic error because the dialog never asks again. Their only
escape is removing the app in their Facebook settings. Adding
`auth_type=rerequest` to the dialog URL is a no-op for everyone else and makes
the dead end self-healing.

### What we already get right

`state` is HMAC-signed with a 15-minute expiry (stronger than the documented
minimum); the App Secret is server-side only; we never hand a token to a client;
the code exchange is server-to-server; HTTPS throughout; we request the minimum
permission, which is why no App Review is needed.

### Flagged, not fixed

- **The `state` is not bound to the browser session.** It proves *we* generated
  it, but the nonce is not stored, so it is replayable inside the 15-minute
  window. A login-CSRF attacker could land a victim in the attacker's workspace.
  The standard fix binds the nonce to an HttpOnly cookie — which would introduce
  cookies to a codebase that has deliberately used only `sessionStorage` bearer
  tokens, so it is a design decision rather than a tweak.
- **Session info tokens.** Meta says apps that authenticate with Facebook Login
  but manage their own logged-in state "should" retain a session info token and
  poll `/debug_token`, so a hacked or disconnected Facebook account logs the
  person out here too. Declined deliberately: it needs a long-lived token first,
  per-user token storage and a cron, against sessions that already expire in
  eight hours and stateless bearer tokens we cannot revoke anyway.

---

## Console checklist (per Facebook app)

Read off the security, use-case and best-practice pages. Items 1–3 matter before
anyone without a role on the app can sign in.

1. **Increase access for `public_profile`** — Use cases → Facebook Login →
   *Increase access*. Required to "serve users who don't have a role on your app".
   With only app admins signing in, its absence is invisible.
2. **Permission status reads "Ready for live mode"**, not "Verification
   required" (that one needs a verified Meta Business Account on the app).
3. **Strict Mode on**, with every deployment origin listed in Valid OAuth
   Redirect URIs. Safe for us: `callbackUri()` is exactly `${origin}/auth/callback`
   with no query parameters, and `state` is ignored by the matcher.
4. **"Login with JavaScript SDK" off**, Allowed Domains empty — we don't use it.
5. **Disable unused auth flows** — embedded browser OAuth, mobile SSO.
6. **Deauthorize callback + data deletion callback** configured (Facebook Login →
   Settings).
7. **"Require App Secret"** (App Settings → Advanced → Security) — **only after
   `appsecret_proof` ships.** Enabling it first kills Facebook login instantly.

## Before the Facebook app can go Live

- **Privacy policy URL.** smartist.studio has an impressum but no privacy policy.
- **Data deletion callback**, or a link to deletion instructions. Named on three
  separate pages as a GDPR requirement.
- **Self-service account deletion.** "Give them a way to log out, disconnect
  their account, or delete it all together… this is also a requirement of our
  Developer Policies for Login." We have logout. There is no delete or disconnect
  anywhere in `app/` or `api/` — only `scripts/delete_artist.js`, a CLI. This is
  a GDPR obligation independent of Facebook.

## Deliberately not doing

- **Business Manager / the Business Mapping API.** Meta: "If you have one primary
  app you are unlikely to need to use the Business Mapping API… we do not
  recommend setting up a business at this time."
- **Facebook Login for Business.** Tempting because the product serves bands, and
  actively destructive: it requires a business permission beyond
  `email`/`public_profile` (dragging us into App Review), switching "will lead to
  the invalidation of all previously installed tokens" for apps that request only
  those two, and newly created Business type apps **cannot switch back**. Meta's
  own FAQ: "If you are not a Tech Provider… Facebook Login is recommended for
  consumer authentication."

## Known cosmetic gap

The login buttons are plain text on the generic `.btn` — no "f" logo, no Facebook
blue (`#1877F2`). Meta's button guidelines say to always use the approved logo
from the Brand Resource Center, placed before the call to action, and forbid
modified logos, so this needs the official asset rather than a hand-drawn "f".
The labels are already correct in all three locales. Google has equivalent
guidelines we are equally not following. Separate frontend pass.
