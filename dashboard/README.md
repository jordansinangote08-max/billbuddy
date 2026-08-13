# BillBuddy Dashboard

Standalone BillBuddy frontend for Render.

## What stays unchanged

- Gmail scanning remains in Google Apps Script.
- Google Sheets remains the BillBuddy database.
- The existing Render PDF worker remains separate.
- The dashboard reads only the secure Apps Script dashboard API.

## Render environment variables

Create these environment variables in the **dashboard** Render service:

### `APPS_SCRIPT_API_URL`

Set this to the Apps Script Web App URL **without** the API key, for example:

`https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec`

Do not add `?api=dashboard&key=...`.

### `DASHBOARD_API_KEY`

Set this to the exact value stored as `DASHBOARD_API_KEY` in Apps Script Script Properties.

Never commit this value to GitHub.

## Render settings

If creating the service manually:

- Runtime: Python
- Root Directory: `dashboard`
- Build Command: `pip install -r requirements.txt`
- Start Command: `gunicorn server:app`

## Local structure

```text
dashboard/
├── server.py
├── requirements.txt
├── templates/
│   └── index.html
└── static/
    ├── style.css
    └── app.js
```

## Health check

Once deployed:

`/health`

should return:

```json
{"ok": true, "service": "billbuddy-dashboard"}
```
