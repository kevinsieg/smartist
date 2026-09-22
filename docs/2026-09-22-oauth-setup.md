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
