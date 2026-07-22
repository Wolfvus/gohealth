<h1 align="center">GoHealth</h1>

<p align="center"><strong>Own your health data.</strong></p>

GoHealth is a local-first TypeScript CLI and Grafana dashboard for exporting your Fitbit and Google Health data, storing daily insights in PostgreSQL, and exploring transparent wellness scores on your own computer.

Your OAuth tokens, raw exports, and database remain local. GoHealth is an independent open-source project and is not affiliated with or endorsed by Google, Fitbit, GoHealth LLC, or any healthcare provider.

## What you get

- Google OAuth 2.0 authorization with offline refresh tokens
- Lossless gzip-compressed JSON exports
- Local PostgreSQL and Grafana containers
- Sleep, activity, physiological-stability, wellness, and confidence scores
- Heart rate, HRV, SpO₂, skin temperature, respiratory rate, sleep, and activity trends
- One small CLI: `goh`

## Requirements

- Node.js 20 or newer
- Docker Desktop, Colima, or another Docker-compatible engine
- A Google account with Google Health/Fitbit data
- A Google Cloud project with Google Health API enabled

## 1. Configure Google Health API

Google Health uses OAuth client credentials, not a simple API key. Each user should create their own Google Cloud project and keep its client secret private.

1. Open Google's [Google Health API setup guide](https://developers.google.com/health/setup).
2. Create or select a Google Cloud project.
3. Enable **Google Health API**.
4. In **Google Auth Platform → Audience**, choose **External**. While the project is in Testing, add your Google account under **Test users**.
5. In **Data Access**, add the Google Health read-only scopes you want. GoHealth requests the scopes listed in [`src/config.ts`](src/config.ts).
6. In **Clients**, create an OAuth client of type **Web application**.
7. Add this exact authorized redirect URI:

   ```text
   http://localhost:3000/oauth2/callback
   ```

8. Download the OAuth credentials JSON.
9. Save it inside this repository as:

   ```text
   .secrets/google-health-client.json
   ```

The `.secrets/` directory is ignored by Git. Alternatively, keep the file anywhere outside the repository and set:

```bash
export GOOGLE_HEALTH_CREDENTIALS=/absolute/path/to/client-credentials.json
```

If authorization reports `org_internal`, change the OAuth audience from Internal to External or use an account in the configured organization. Google currently limits Testing projects to listed test users, and Testing-mode refresh tokens may expire after seven days; see the [official OAuth setup documentation](https://developers.google.com/health/setup).

## 2. Install GoHealth

```bash
git clone https://github.com/YOUR_USERNAME/gohealth.git
cd gohealth
npm install
npm link
```

Confirm the CLI is available:

```bash
goh --help
```

## 3. Authorize and start

```bash
goh auth
goh start
goh open
```

`goh auth` starts a temporary server on port 3000, opens the OAuth flow, securely stores the returned token, and downloads the first export. `goh start` launches PostgreSQL and Grafana and imports the newest export. `goh open` opens the insight dashboard in a focused kiosk view.

## CLI

```text
goh start            Start the dashboard
goh stop             Stop the dashboard
goh restart          Restart the dashboard
goh refresh          Pull and import the latest 30 days
goh refresh 90       Pull and import the latest 90 days
goh status           Show service status
goh open             Open the insights dashboard
goh auth             Renew Google authorization
goh --help           Show help
```

A successful refresh keeps only the newest compressed raw snapshot. Cleanup happens only after both export and database import succeed.

## Scores

GoHealth's scores are intentionally transparent:

- **Sleep:** 80% duration and 20% wearable-estimated efficiency.
- **Activity:** rolling seven-calendar-day Active Zone Minutes against a 150-minute target.
- **Physiological stability:** robust personal-baseline comparison of resting heart rate, HRV, SpO₂, skin temperature, and respiratory rate.
- **Wellness:** 45% sleep, 25% activity, and 30% physiological stability, reweighted when inputs are missing.
- **Confidence:** separate measurement of data coverage and baseline maturity. Scores below 60% confidence are marked provisional.

These are general-wellness summaries, not medical scores, diagnoses, predictions, or treatment recommendations.

## Privacy and security

- OAuth tokens and client credentials are stored under `.secrets/` with owner-only permissions.
- Raw health exports are stored under `data/` as owner-only gzip files.
- Credentials, tokens, exports, `.env`, build output, and local editor state are excluded by `.gitignore`.
- Grafana and PostgreSQL bind only to `127.0.0.1`.
- GoHealth never prints client secrets or refresh tokens.
- Compression is lossless; detailed health samples remain present in the export.

Before publishing a fork, inspect the entire Git history for credentials and personal data. Never commit downloaded OAuth JSON, tokens, or health exports.

## Development

```bash
npm ci
npm run typecheck
npm run build
```

## License

MIT
