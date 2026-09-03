# NiftyCASino email templates

Supabase owns the email-sending side of auth, and its built-in templates are
plain-text one-liners with no branding. These files are the branded replacements.
They cannot be applied by `supabase db push` (templates are dashboard/project
config, not migrations), so they live here as the source of truth to paste in.

## Templates

| File                   | Supabase template | Subject line                                                      |
| ---------------------- | ----------------- | ----------------------------------------------------------------- |
| `confirm-signup.html`  | **Confirm signup**  | `Confirm your email — your 1,000 NC are waiting · NiftyCASino`    |
| `reset-password.html`  | **Reset Password**  | `Reset your password · NiftyCASino`                               |

Both are built from `{{ .TokenHash }}` (the shape the Supabase SSR guides
recommend) and link to the app's own `/auth/confirm` route, which exchanges the
token server-side and redirects:

- **signup** → `/auth/login?verified=1` — the login screen with the
  "Email verified" banner. We deliberately do not auto-sign-in off the emailed
  link: the player sees the confirmation and logs in intentionally.
- **recovery** → `/auth/reset` — the new-password form (needs the session the
  token mints, which is why only signup gets signed back out).

## How to apply (Dashboard)

1. Supabase Dashboard → **Authentication → Emails → Templates**.
2. Open the template, paste the **subject** from the table above and the full
   **body** from the file (the whole HTML document — Supabase wraps it itself).
3. Save. Repeat for the other template. No redeploy of the app is needed.

## Site URL requirement

The templates build links from `{{ .SiteURL }}`, which Supabase fills with the
project's **Authentication → URL Configuration → Site URL**. That must be the
production origin (`https://niftycasino.com` or wherever the app is deployed) —
if it still points at `localhost`, every emailed link lands on localhost.

If you would rather hardcode the domain, replace every `{{ .SiteURL }}` in the
two files with the literal origin. Also check **Redirect URLs** includes
`<site-url>/auth/confirm`, or Supabase will reject the redirect for
`{{ .ConfirmationURL }}`-style links.

## Gotchas already handled, for the record

- Token expiry follows **Authentication → Emails → OTP expiry** (default 24h —
  the copy in the emails says 24h; keep them in sync if you change it).
- "Resend the link" on `/auth/verify` is rate-limited by the built-in provider
  to one email per address per 60s; the 429 surfaces in the UI, not swallowed.
- A link clicked twice lands on `/auth/login` with the readable
  "already used" banner (`/auth/confirm` handles that case).
