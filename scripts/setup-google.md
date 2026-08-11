# Google Cloud setup for Multigmail

## 1. Create a project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create (or select) a project.
3. Enable these APIs:
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)

## 2. Configure OAuth consent

1. Go to **Google Auth Platform → Branding / Audience**.
2. User type: **External** (unless this is a Workspace-only Internal app).
3. Add yourself (and any other Gmail accounts you will connect) as **Test users** while the app is in testing.
4. Under **Data Access / Scopes**, add:

```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

## 3. Create OAuth client

1. **Clients → Create Client → Web application**.
2. Authorized redirect URIs:
   - `http://localhost:8787/callback` (local Wrangler)
   - `https://<your-worker>.workers.dev/callback` (production)
3. Copy the **Client ID** and **Client Secret**.

## 4. Local secrets

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with your client id/secret and a long random COOKIE_ENCRYPTION_KEY
```

Generate an encryption key:

```bash
openssl rand -base64 32
```

## 5. Production secrets

```bash
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY
pnpm exec wrangler secret put WORKER_URL
# optional:
# pnpm exec wrangler secret put HOSTED_DOMAIN
```

`WORKER_URL` must be the public HTTPS origin of the Worker (no trailing slash), used when Claude returns an `add_account` Google OAuth link.
