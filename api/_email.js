// ── Email provider ────────────────────────────────────────────────────────────
// Current: Resend (https://resend.com)
// To switch providers: update url, envVar, auth, and buildBody to match the
// new provider's REST API. The sendEmail() signature is unchanged for callers.
//   Postmark:  url = 'https://api.postmarkapp.com/email'
//              auth = key => key  (X-Postmark-Server-Token header instead — also update header below)
//              buildBody = ({ from, to, subject, text, html }) =>
//                ({ From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html })
//   SendGrid:  url = 'https://api.sendgrid.com/v3/mail/send'
//              buildBody = ({ from, to, subject, text, html }) =>
//                ({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject,
//                   content: [{ type: 'text/html', value: html }] })
const PROVIDER = {
  envVar:    'RESEND_API_KEY',
  url:       'https://api.resend.com/emails',
  auth:      key => `Bearer ${key}`,
  buildBody: ({ from, to, subject, text, html, attachments, reply_to }) =>
    ({ from, to, subject, text, html, attachments, ...(reply_to ? { reply_to } : {}) }),
};
// ─────────────────────────────────────────────────────────────────────────────

const FROM = process.env.RESEND_FROM || 'Smartist Studio <noreply@smartist.studio>';

/**
 * @param {{ to: string, subject: string, text?: string, html?: string,
 *   attachments?: { filename: string, content: string }[], reply_to?: string }} mail
 */
async function sendEmail({ to, subject, text, html, attachments, reply_to }) {
  const apiKey = process.env[PROVIDER.envVar];
  if (!apiKey) throw new Error(`${PROVIDER.envVar} not configured`);

  const r = await fetch(PROVIDER.url, {
    method:  'POST',
    headers: { 'Authorization': PROVIDER.auth(apiKey), 'Content-Type': 'application/json' },
    body:    JSON.stringify(PROVIDER.buildBody({ from: FROM, to, subject, text, html, attachments, reply_to })),
    // A stalled provider must not hold the function until the platform kills it.
    signal:  AbortSignal.timeout(10000),
  });

  if (!r.ok) {
    const body = await r.text();
    // Not printed here: the reply can quote the recipient. Callers log the
    // error through the logger, which redacts addresses.
    throw new Error(`email send failed: ${r.status} ${body.slice(0, 300)}`);
  }
}

module.exports = { sendEmail };
