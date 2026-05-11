# FFVC Job Matcher

Live job matching widget: candidates paste their resume → system scrapes all FFVC portfolio careers pages live → AI extracts and ranks every open position by fit.

---

## What's in this repo

```
ffvc-matcher/
├── api/
│   └── match.js          ← Vercel serverless function (scraping + AI)
├── widget.html           ← Embeddable widget (drop into any website)
├── vercel.json           ← Vercel config (CORS, timeouts)
├── package.json
├── .env.example          ← Environment variable template
└── README.md
```

---

## One-time setup (15 minutes)

### Step 1: Google Sheets

1. Create a Google Sheet with these columns in row 1:
   ```
   Name | Website | Careers URL | Stage | Active
   ```
2. Add your portfolio companies. Put `Y` in the Active column for companies to scrape.
3. Copy the Sheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/[THIS_IS_THE_ID]/edit
   ```

### Step 2: Google Service Account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable the **Google Sheets API**
4. Go to **IAM & Admin → Service Accounts → Create Service Account**
5. Name it `ffvc-matcher`, click through to create
6. Click the service account → **Keys → Add Key → JSON**
7. Download the JSON file — you'll need `client_email` and `private_key` from it
8. Share your Google Sheet with the service account email (viewer access)

### Step 3: Deploy to Vercel

**Option A: GitHub (recommended)**
1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → New Project → Import your repo
3. Click Deploy (no build settings needed)

**Option B: Vercel CLI**
```bash
npm i -g vercel
cd ffvc-matcher
vercel --prod
```

### Step 4: Set environment variables

In Vercel → Your Project → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GOOGLE_SHEET_ID` | The Sheet ID from step 1 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON file |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON file (paste the full value including `-----BEGIN...END-----`) |

Redeploy after adding variables: Vercel → Deployments → Redeploy.

### Step 5: Update the widget

Open `widget.html` and find line ~310:
```js
const API_URL = 'https://YOUR_VERCEL_URL.vercel.app/api/match';
```
Replace `YOUR_VERCEL_URL` with your actual Vercel project name (shown after deploy).

### Step 6: Embed on your website

Add this one line anywhere on your website:

```html
<iframe src="https://YOUR_VERCEL_URL.vercel.app/widget.html" 
        style="width:100%;height:900px;border:none;" 
        title="FFVC Job Matcher">
</iframe>
```

Or if you prefer hosting the widget HTML yourself, upload `widget.html` to your own CDN/server and embed that URL instead.

---

## How it works

1. Candidate pastes resume → hits submit
2. Widget POSTs to `/api/match` (your Vercel function)
3. Function reads active companies from Google Sheets
4. Scrapes all careers pages in parallel (up to 10 pages each, 60s timeout)
5. Claude AI extracts structured job listings from each page's HTML
6. Claude AI matches resume against all jobs, scores 0-100
7. Results stream back to the widget via Server-Sent Events
8. Candidate sees ranked job cards with match %, reason, and matched skills

**LinkedIn URLs** are detected and flagged for manual review — not scraped.  
**Failed scrapes** are skipped silently — other companies continue.

---

## Customization

**Colors / branding:** Edit the CSS variables at the top of `widget.html`:
```css
:root {
  --accent: #6366f1;  /* Change to your brand color */
  ...
}
```

**Google Sheet columns:** The function reads columns A–E. If your sheet has a different structure, update `getCompanies()` in `api/match.js`.

**AI prompts:** Edit `extractJobsFromText()` and `matchResumeToJobs()` in `api/match.js`.

**Timeout:** Default is 60 seconds (Vercel's max on free tier). Upgrade to Pro for 300s if you have many companies.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Failed to read Google Sheet" | Check service account email is shared on the sheet; verify env vars are set |
| Widget shows no jobs | Check the Vercel function logs; many sites block scraping |
| Timeout errors | Reduce number of active companies, or upgrade Vercel plan |
| CORS errors | Verify `vercel.json` is deployed; check API_URL in widget.html |
| Private key errors | Make sure the full key is pasted including header/footer lines |
