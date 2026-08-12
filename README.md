# BillBuddy — Simple Free Edition

This package is the simplified BillBuddy build:

**Gmail `Billz` → Google Apps Script → Google Sheets → private Apps Script dashboard**

GitHub is used only to store/backup the source code and bank-logo assets. The live financial dashboard should be deployed from Google Apps Script, not GitHub Pages, so the bill data is not exposed on a public static website.

## What this version already does

- Scans Gmail messages under the `Billz` label.
- Discovers new senders/products automatically.
- New sources default to **Pending**.
- Lets you **Track**, **Ignore**, and re-enable sources from the dashboard.
- Reads the email body first.
- Extracts **Total Amount Due**, **Due Date**, Statement Date, and Billing Period when present.
- Never intentionally selects **Minimum Amount Due** as Total Amount Due.
- Looks at a PDF only when required fields are missing.
- Uses Google Drive OCR/conversion for normal PDFs.
- Marks unreadable/password-protected PDFs as **Needs Review** instead of guessing.
- Supports an optional AI text-reading fallback, disabled by default.
- Applies the known EastWest, UnionBank credit-card, and RCBC date rules without mixing UnionBank Personal Loan with UnionBank Credit Card.
- Uses a `Holidays in Philippines` Google Calendar when available for business-day adjustments.
- Stores data in Google Sheets.
- Creates `Billz/Processed`, `Billz/Pending`, `Billz/Excluded`, `Billz/Needs-Review`, and `Billz/Failed` Gmail labels.
- Includes a responsive BillBuddy dashboard.

## Important limitation: encrypted PDFs

Google Apps Script/Drive can read many ordinary PDFs, but this package does **not** brute-force or guess PDF passwords. If a password-protected statement cannot be converted/read, BillBuddy marks it **Needs Review**.

A secure password-PDF worker can be added later. The intended rule is: read the password instruction from the email, generate only the authorized password format, unlock the PDF, extract text, and immediately discard the password. Do not put DOBs or PDF passwords in GitHub.

## Optional AI reader

AI is **OFF by default**. The deterministic extractor runs first. If you later enable AI, it should receive only text that still needs interpretation, and it must return `null` rather than inventing uncertain values.

To enable the included Gemini hook, add Script Properties:

- `GEMINI_API_KEY` = your key
- `GEMINI_MODEL` = model name (optional)

Then change the `Settings` sheet value `ai_enabled` from `false` to `true`.

Before doing that, review the provider's current privacy and free-tier terms because financial-statement text is sensitive.

## Files

- `apps-script/Code.gs` — complete BillBuddy backend/automation.
- `apps-script/Index.html` — responsive private dashboard.
- `apps-script/appsscript.json` — Apps Script manifest with Drive advanced service.
- `assets/logos/` — the bank logo PNGs you supplied.

## Setup — do these steps in order

### 1. Upload this repository to GitHub

Create a repository named `billbuddy` and upload **everything inside this folder**. Do not upload passwords, DOBs, Gmail tokens, API secrets, or PDF passwords.

GitHub is only the source-code backup for this simplified build.

### 2. Create the BillBuddy Google Sheet

Create a new Google Sheet named **BillBuddy**.

You do not need to manually create tabs or columns; the setup function will do that.

### 3. Open Apps Script

From the BillBuddy Sheet:

**Extensions → Apps Script**

Delete the starter code in `Code.gs` and paste the full contents of:

`apps-script/Code.gs`

### 4. Add the dashboard HTML file

In Apps Script, click the **+** beside Files → **HTML**.

Name it exactly:

`Index`

Paste the full contents of:

`apps-script/Index.html`

### 5. Add the manifest

In Apps Script → **Project Settings**, enable **Show "appsscript.json" manifest file in editor**.

Open `appsscript.json` and replace its contents with:

`apps-script/appsscript.json`

### 6. Confirm the Drive advanced service

In Apps Script, open **Services**. If **Drive API** is not shown, click **+ Add a service**, choose **Drive API**, and add it.

This is used only for best-effort PDF text extraction/OCR.

### 7. Create the Gmail source label

In Gmail create or confirm this label exists:

`Billz`

Put the bill emails you want BillBuddy to inspect under that label.

### 8. Run the one-time setup

In Apps Script, choose the function:

`setupBillBuddy`

Click **Run** and approve the Google permissions requested by your own script.

This creates the Sheets tabs and Gmail processing labels.

### 9. Run the first scan

Choose:

`scanBillz`

Click **Run**.

Because new sources default to Pending, the first scan will normally discover sources rather than process them financially.

### 10. Deploy the dashboard

Apps Script → **Deploy → New deployment → Web app**.

- Execute as: **Me**
- Who has access: choose the **most restrictive option available**, preferably **Only myself**.

Do **not** deploy a financial dashboard publicly just to avoid a login prompt. If your account does not offer a private/restricted access option, stop and ask for help before selecting `Anyone`.

Open the Web App URL while signed into your Google account.

There is no separate BillBuddy username/password; access is controlled by your existing Google account.

### 11. Approve or ignore discovered sources

Open **Tracking & Sources**.

For every new source choose:

- **Track** — future/current eligible messages can be processed.
- **Ignore** — messages are intentionally excluded.

After choosing Track for the sources you want, press **Scan Billz** again.

### 12. Turn on automatic scanning

In Apps Script run:

`installBillBuddyTrigger`

This creates an hourly scan trigger.

If you ever want to stop automatic scanning, run:

`removeBillBuddyTrigger`

## Normal processing flow

```text
Gmail Billz
  ↓
Identify sender + product
  ↓
Pending / Included / Excluded
  ↓
Included only
  ↓
Read email body
  ↓
Amount + due date available?
  ├─ YES → validate → save
  └─ NO  → inspect PDF
             ↓
         readable PDF?
         ├─ YES → extract missing fields → validate → save
         └─ NO  → Needs Review
```

## What to add later

The next optional component is a secure encrypted-PDF worker. It is only necessary for statements whose required values are missing from the email and whose PDF is password-protected.

Keep the first working version simple before adding that component.
