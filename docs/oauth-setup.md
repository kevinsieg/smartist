# Google and Facebook sign-in

Optional. With neither provider configured, people sign up and log in with an
email address and password. Each provider switches itself on when **both** of
its variables are set; `GET /api/config` then reports `googleLogin` /
`facebookLogin: true` and the login and signup pages show the button.

---

## What the app needs

| | Value | Where it comes from |
|---|---|---|
| Redirect URI | `<APP_ORIGIN>/auth/callback` | `callbackUri()` in `api/_domain/oauth.js`; `/auth/callback` is rewritten to `/api/config?action=oauth-callback` in `vercel.json` |
| Google scopes | `openid email` | `googleUrl()` in `api/_domain/oauth.js` |
| Facebook scope | `email` (with `auth_type=rerequest`) | `facebookUrl()` in `api/_domain/oauth.js` |
| Env vars | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, optionally `FACEBOOK_TRUST_EMAIL` | `api/_domain/identity.js`, `api/_domain/oauth.js` |

**Set `APP_ORIGIN`.** The redirect URI is built from it (`api/_domain/http.js`),
so one registered URI covers every entry point of a deployment, including a
demo subdomain that redirects into the app. Without it the URI falls back to
the request's `Host` header.

Use separate OAuth apps per deployment: the consent screen then names that
deployment, and rotating one deployment's credentials does not touch the others.

---

## Google

1. **console.cloud.google.com** → create or pick a project.
2. **APIs & Services → OAuth consent screen**: External, app name, support
   email, your domain as an authorised domain. Scopes: `openid` and `email` only.
3. **Credentials → Create credentials → OAuth client ID**
   - Type: **Web application**
   - **Authorised redirect URIs:** `https://<your domain>/auth/callback`
   - Authorised JavaScript origins: leave empty — the code exchange happens on
     the server.
4. Copy the **Client ID** and **Client secret**.

**Unverified addresses are rejected.** `resolveOAuthEmail()` in
`api/_domain/identity.js` reads `verified_email` from Google's userinfo endpoint
and accepts the address only when it is exactly `true`. Email is the identity
across workspaces, so an unverified address would be a way into someone else's
account. If a test account cannot sign in, check that its address is confirmed
with Google first.

---

## Facebook

1. **developers.facebook.com** → Create App → type **Consumer**, use case
   *Authenticate and request data from users with Facebook Login*.
2. **Facebook Login → Settings**
   - **Valid OAuth Redirect URIs:** `https://<your domain>/auth/callback`
   - Client OAuth Login and Web OAuth Login: on; Strict Mode: on.
3. **App settings → Basic**: app domain, privacy policy URL, data-deletion
   instructions URL (account deletion is self-service under `/profile`).
4. Copy the **App ID** and **App Secret**.
5. Make the app **Live**. In development mode only people with a role on the app
   can sign in. Meta may require a *verified business portfolio* before a new
   app with this use case can go Live.

**Facebook addresses are opt-in.** Facebook has no equivalent of Google's
`verified_email`: its Graph API returns "the User's primary email address …
This field will not be returned if no valid email address is available" —
*valid*, not *confirmed*. Meta does document matching that address to an
existing account as a supported pattern, but it is not a guarantee. So by
default a Facebook sign-in neither signs into an existing account nor sets up
a new one: a new address is sent to the signup page, which emails a link to
prove it. (Memberships join on email, so a workspace set up under someone
else's address would later reach every band that invites them.) Set
`FACEBOOK_TRUST_EMAIL=true` on a deployment to allow both.

What the code already does, following Meta's security guidance:

- every Graph API call after the token exchange carries a timestamped
  `appsecret_proof` (so **Require App Secret** can be switched on);
- the Graph API version is pinned (`FB_GRAPH_VERSION` in `api/_constants.js`,
  currently `v25.0`);
- the dialog sends `auth_type=rerequest`, so someone who once declined the
  email permission is asked again instead of being locked out.

### Console checklist (per Facebook app)

1. **Increase access for `public_profile`** (Use cases → Facebook Login) — needed
   to serve people without a role on the app.
2. Permission status reads **"Ready for live mode"**.
3. **Strict Mode on**, every deployment origin listed in Valid OAuth Redirect
   URIs. `callbackUri()` has no query parameters, so exact matching works.
4. **"Login with JavaScript SDK" off** — the SDK is not used.
5. Unused auth flows (embedded browser OAuth, mobile SSO) off.
6. **Require App Secret** on (App Settings → Advanced → Security).

Not used on purpose: *Facebook Login for Business* (needs business permissions
and App Review, and an app cannot switch back) and the Business Mapping API.

---

## How the flow is protected

- **`state`** is HMAC-signed (keyed with the provider's client secret) and
  expires after 15 minutes. It also carries a random nonce that the OAuth start
  sets as an `oauth_nonce` cookie (HttpOnly, Secure, SameSite=Lax); the callback
  refuses a state whose nonce does not match the cookie. A callback URL minted
  in one browser therefore cannot sign another browser in (login CSRF).
- The code exchange is server-to-server; no provider token reaches the browser.
- The callback answers every failure the same way (`/login?oauth_error=1`); the
  reason is only logged, so the page does not reveal whether an address has an
  account.
- A successful sign-in returns a normal session token in the URL fragment
  (`/login#session=…`), never in a query string.

---

## Setting the variables

```bash
vercel env add GOOGLE_CLIENT_ID production --project <name>
vercel env add GOOGLE_CLIENT_SECRET production --project <name>
vercel env add FACEBOOK_APP_ID production --project <name>
vercel env add FACEBOOK_APP_SECRET production --project <name>
```

Then **redeploy**: Vercel bakes variables into the build, so adding one to a
live deployment changes nothing until it is rebuilt.

```bash
vercel ls <name>                     # the Production deployment's URL
vercel redeploy <that-url>
```

---

## Verifying

```bash
curl -s https://<your domain>/api/config | grep -o '"googleLogin":[a-z]*'
curl -s https://<your domain>/api/config | grep -o '"facebookLogin":[a-z]*'
```

Both must be `true` for the providers you configured. Then, in a browser,
`/login` and `/signup` show the buttons; from either, a full sign-in lands on
`/onboarding` for a new address, or on the workspace dashboard for an existing
Google account.

If a button appears but the flow fails, the reason is in the function logs
(`oauth_callback_failed` with a `reason`), not in the browser:

```bash
vercel inspect https://<your domain>     # deployment id
vercel logs <deployment-url>
```

---

## Known gaps

- The login buttons are plain text. Google's and Meta's brand guidelines ask for
  their official logos and colours; that needs the official assets.
- Facebook session info tokens (polling `/debug_token` so a disconnected Facebook
  account also ends the session here) are not implemented; sessions end on their
  own after 8 hours, or 30 days with "remember me".
