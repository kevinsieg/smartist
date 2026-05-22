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

const FROM = process.env.RESEND_FROM || 'Band Tools <noreply@example.com>';

async function sendEmail({ to, subject, text, html, attachments, reply_to }) {
  const apiKey = process.env[PROVIDER.envVar];
  if (!apiKey) throw new Error(`${PROVIDER.envVar} not configured`);

  const r = await fetch(PROVIDER.url, {
    method:  'POST',
    headers: { 'Authorization': PROVIDER.auth(apiKey), 'Content-Type': 'application/json' },
    body:    JSON.stringify(PROVIDER.buildBody({ from: FROM, to, subject, text, html, attachments, reply_to })),
  });

  if (!r.ok) {
    const body = await r.text();
    console.error(`[email] ${r.status}: ${body}`);
    throw new Error(`email send failed: ${r.status}`);
  }
  console.log(`[email] sent to=${Array.isArray(to) ? to.join(',') : to} subject="${subject}"`);
}

module.exports = { sendEmail };
