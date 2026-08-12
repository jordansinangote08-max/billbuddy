/**
 * BillBuddy - simplified, free-first Google Apps Script edition.
 *
 * Core rule: EMAIL FIRST. PDF ONLY WHEN NEEDED.
 * Unknown sources are PENDING by default.
 * Password-protected PDFs are NOT brute-forced. If Apps Script cannot read them,
 * the item is marked Needs Review. An optional secure PDF worker can be added later.
 */

const BB = {
  SHEETS: {
    BILLS: 'Bills',
    ACCOUNTS: 'Accounts',
    SOURCES: 'Sources',
    SETTINGS: 'Settings'
  },
  LABELS: {
    ROOT: 'Billz',
    PROCESSED: 'Billz/Processed',
    REVIEW: 'Billz/Needs-Review',
    FAILED: 'Billz/Failed',
    EXCLUDED: 'Billz/Excluded',
    PENDING: 'Billz/Pending'
  }
};

function setupBillBuddy() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, BB.SHEETS.BILLS, [
    'id','account_key','bank_lender','product_type','statement_date',
    'billing_period_start','billing_period_end','due_date','total_amount_due',
    'currency','gmail_message_id','gmail_subject','sender_email','pdf_used',
    'processing_status','confidence','processed_at'
  ]);
  ensureSheet_(ss, BB.SHEETS.ACCOUNTS, [
    'account_key','bank_lender','product_type','display_name','logo_key',
    'credit_limit','utilization_target','tracking_status','active',
    'first_seen_at','last_seen_at'
  ]);
  ensureSheet_(ss, BB.SHEETS.SOURCES, [
    'source_key','source_name','sender_email','sender_domain','bank_lender',
    'product_type','tracking_status','reason','first_seen_at','last_seen_at'
  ]);
  ensureSheet_(ss, BB.SHEETS.SETTINGS, ['key','value']);

  setSettingIfMissing_('auto_track_new_sources', 'false');
  setSettingIfMissing_('unknown_source_default_status', 'pending');
  setSettingIfMissing_('due_soon_days', '7');
  setSettingIfMissing_('ai_enabled', 'false');

  Object.values(BB.LABELS).forEach(getOrCreateLabel_);
  SpreadsheetApp.getUi().alert('BillBuddy setup complete.');
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('BillBuddy')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function getDashboardData() {
  const bills = rowsAsObjects_(BB.SHEETS.BILLS);
  const accounts = rowsAsObjects_(BB.SHEETS.ACCOUNTS)
    .filter(r => String(r.tracking_status).toLowerCase() === 'included' && String(r.active).toLowerCase() !== 'false');
  const sources = rowsAsObjects_(BB.SHEETS.SOURCES);

  const activeBills = bills.filter(r => String(r.processing_status).toLowerCase() === 'processed');
  const total = activeBills.reduce((s,r) => s + (Number(r.total_amount_due) || 0), 0);
  const today = startOfDay_(new Date());
  const soonDays = Number(getSetting_('due_soon_days') || 7);
  let dueSoon = 0, overdue = 0;
  activeBills.forEach(r => {
    if (!r.due_date) return;
    const d = startOfDay_(new Date(r.due_date));
    const diff = Math.floor((d - today) / 86400000);
    if (diff < 0) overdue++;
    else if (diff <= soonDays) dueSoon++;
  });

  return {
    summary: {totalAmountDue: total, accounts: accounts.length, dueSoon, overdue},
    bills: activeBills.sort((a,b) => new Date(a.due_date || '2999-12-31') - new Date(b.due_date || '2999-12-31')),
    accounts,
    sources: {
      pending: sources.filter(r => String(r.tracking_status).toLowerCase() === 'pending'),
      included: sources.filter(r => String(r.tracking_status).toLowerCase() === 'included'),
      excluded: sources.filter(r => String(r.tracking_status).toLowerCase() === 'excluded')
    }
  };
}

function setSourceStatus(sourceKey, newStatus, reason) {
  newStatus = String(newStatus || '').toLowerCase();
  if (!['included','excluded','pending'].includes(newStatus)) throw new Error('Invalid status');
  const sh = SpreadsheetApp.getActive().getSheetByName(BB.SHEETS.SOURCES);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const keyCol = headers.indexOf('source_key');
  const statusCol = headers.indexOf('tracking_status');
  const reasonCol = headers.indexOf('reason');
  const lastCol = headers.indexOf('last_seen_at');
  let found = false;
  for (let i=1;i<data.length;i++) {
    if (String(data[i][keyCol]) === String(sourceKey)) {
      sh.getRange(i+1, statusCol+1).setValue(newStatus);
      if (reasonCol >= 0) sh.getRange(i+1, reasonCol+1).setValue(reason || '');
      if (lastCol >= 0) sh.getRange(i+1, lastCol+1).setValue(new Date());
      found = true;
      break;
    }
  }
  if (!found) throw new Error('Source not found');

  // Keep any existing account aligned with source status. Historical bills are NOT deleted.
  syncAccountsForSource_(sourceKey, newStatus);
  return getDashboardData();
}

function scanBillz() {
  const root = GmailApp.getUserLabelByName(BB.LABELS.ROOT);
  if (!root) throw new Error('Gmail label "Billz" does not exist. Create it first.');
  const threads = GmailApp.search('label:Billz newer_than:120d', 0, 100);
  let processed = 0, pending = 0, excluded = 0, review = 0, failed = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      try {
        if (billExists_(message.getId())) return;
        const sender = parseSender_(message.getFrom());
        const subject = message.getSubject() || '';
        const body = message.getPlainBody() || stripHtml_(message.getBody() || '');
        const identity = identifySource_(sender.email, subject, body);
        const source = discoverSource_(identity, sender);

        if (source.tracking_status === 'excluded') {
          thread.addLabel(getOrCreateLabel_(BB.LABELS.EXCLUDED));
          excluded++;
          return;
        }
        if (source.tracking_status !== 'included') {
          thread.addLabel(getOrCreateLabel_(BB.LABELS.PENDING));
          pending++;
          return;
        }

        let fields = extractFinancialFields_(body, subject);
        let pdfUsed = false;
        let combinedText = body;

        if (!isFinancialDataComplete_(fields)) {
          const pdfs = message.getAttachments({includeInlineImages:false, includeAttachments:true})
            .filter(a => String(a.getContentType()).toLowerCase().includes('pdf') || /\.pdf$/i.test(a.getName()));
          for (const pdf of pdfs) {
            const pdfText = extractPdfTextBestEffort_(pdf);
            if (pdfText) {
              pdfUsed = true;
              combinedText += '\n\n' + pdfText;
              fields = mergeFields_(fields, extractFinancialFields_(pdfText, subject));
              if (isFinancialDataComplete_(fields)) break;
            }
          }
        }

        // Optional AI fallback on text only. Off by default.
        if (!isFinancialDataComplete_(fields) && String(getSetting_('ai_enabled')).toLowerCase() === 'true') {
          const ai = aiExtractFields_(combinedText);
          fields = mergeFields_(fields, ai || {});
        }

        const account = ensureAccount_(identity, source.source_key);
        if (!isFinancialDataComplete_(fields)) {
          saveBill_(message, account, identity, fields, pdfUsed, 'needs_review', 0.50);
          thread.addLabel(getOrCreateLabel_(BB.LABELS.REVIEW));
          review++;
          return;
        }

        fields = applyProductRules_(identity, fields);
        saveBill_(message, account, identity, fields, pdfUsed, 'processed', fields.confidence || 0.90);
        thread.addLabel(getOrCreateLabel_(BB.LABELS.PROCESSED));
        processed++;
      } catch (err) {
        console.error(err && err.stack ? err.stack : err);
        thread.addLabel(getOrCreateLabel_(BB.LABELS.FAILED));
        failed++;
      }
    });
  });
  return {processed, pending, excluded, review, failed};
}

function installBillBuddyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'scanBillz').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanBillz').timeBased().everyHours(1).create();
  return 'Hourly BillBuddy trigger installed.';
}

function removeBillBuddyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'scanBillz').forEach(t => ScriptApp.deleteTrigger(t));
  return 'BillBuddy trigger removed.';
}

function identifySource_(email, subject, body) {
  const text = `${subject}\n${body}`.toLowerCase();
  const domain = (email.split('@')[1] || '').toLowerCase();
  let bank = titleFromDomain_(domain);
  const known = [
    ['unionbank','UnionBank'], ['eastwest','EastWest'], ['rcbc','RCBC'], ['bdo','BDO'],
    ['bpi','BPI'], ['chinabank','Chinabank'], ['metrobank','Metrobank'],
    ['securitybank','Security Bank'], ['maribank','MariBank']
  ];
  for (const [needle,name] of known) {
    if (text.includes(needle) || domain.includes(needle)) { bank = name; break; }
  }
  let product = 'bill';
  if (/personal\s+loan|loan statement|loan payment|amortization/.test(text)) product = 'personal_loan';
  else if (/credit\s*card|card statement|statement of account|soa/.test(text)) product = 'credit_card';
  else if (/electric|meralco|utility/.test(text)) product = 'utility';
  else if (/internet|broadband|fiber/.test(text)) product = 'internet';
  else if (/insurance|premium/.test(text)) product = 'insurance';
  else if (/subscription|membership/.test(text)) product = 'subscription';
  return {bank_lender: bank || 'Unknown', product_type: product, source_name: `${bank || email} ${humanize_(product)}`.trim()};
}

function extractFinancialFields_(text, subject) {
  text = String(text || '').replace(/\u00a0/g,' ');
  const result = {currency:'PHP', confidence:0.65};

  // Prefer explicit TOTAL AMOUNT DUE labels. Avoid Minimum Amount Due.
  const amountPatterns = [
    /total\s+amount\s+due\s*[:\-]?\s*(?:php|₱|p)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
    /amount\s+due\s*[:\-]?\s*(?:php|₱|p)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
    /total\s+due\s*[:\-]?\s*(?:php|₱|p)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i
  ];
  for (const re of amountPatterns) {
    const m = text.match(re);
    if (m && !/minimum\s+amount\s+due/i.test(m[0])) { result.total_amount_due = parseMoney_(m[1]); result.confidence = 0.90; break; }
  }

  const duePatterns = [
    /(?:payment\s+)?due\s+date\s*[:\-]?\s*([^\n\r]{4,35})/i,
    /due\s+on\s*[:\-]?\s*([^\n\r]{4,35})/i,
    /pay\s+by\s*[:\-]?\s*([^\n\r]{4,35})/i
  ];
  for (const re of duePatterns) {
    const m = text.match(re);
    if (m) { const d = parseDateLoose_(m[1]); if (d) { result.due_date = d; break; } }
  }

  const stPatterns = [
    /statement\s+date\s*[:\-]?\s*([^\n\r]{4,35})/i,
    /billing\s+date\s*[:\-]?\s*([^\n\r]{4,35})/i
  ];
  for (const re of stPatterns) {
    const m = text.match(re);
    if (m) { const d = parseDateLoose_(m[1]); if (d) { result.statement_date = d; break; } }
  }

  const period = text.match(/(?:billing|statement)\s+period\s*[:\-]?\s*([^\n\r]{4,30})\s+(?:to|\-|–)\s*([^\n\r]{4,30})/i);
  if (period) {
    const a = parseDateLoose_(period[1]), b = parseDateLoose_(period[2]);
    if (a) result.billing_period_start = a;
    if (b) result.billing_period_end = b;
  }
  return result;
}

function isFinancialDataComplete_(f) {
  return Number(f.total_amount_due) >= 0 && !!f.due_date;
}

function extractPdfTextBestEffort_(blob) {
  // Google Drive OCR/conversion works for many normal PDFs. Encrypted PDFs may fail.
  // Password guessing/brute force is intentionally not implemented.
  let fileId = null;
  let docId = null;
  try {
    const metadata = {name: `BillBuddy temp ${Date.now()}`, mimeType: 'application/vnd.google-apps.document'};
    const created = Drive.Files.create(metadata, blob, {ocrLanguage:'en'});
    docId = created.id;
    const doc = DocumentApp.openById(docId);
    const text = doc.getBody().getText();
    return text || '';
  } catch (e) {
    console.warn('PDF extraction failed; likely encrypted/unsupported: ' + e.message);
    return '';
  } finally {
    if (docId) { try { DriveApp.getFileById(docId).setTrashed(true); } catch (e) {} }
    if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {} }
  }
}

function aiExtractFields_(text) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) return null;
  const model = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const safeText = String(text || '').slice(0, 25000);
  const prompt = `Extract billing fields from the text below. Return JSON only with keys: total_amount_due, due_date, statement_date, billing_period_start, billing_period_end, currency, confidence.\nRules: total_amount_due must NEVER be minimum amount due. Dates must be YYYY-MM-DD. If unsure, use null. Do not invent values.\n\nTEXT:\n${safeText}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = UrlFetchApp.fetch(url, {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    payload: JSON.stringify({contents:[{parts:[{text:prompt}]}], generationConfig:{responseMimeType:'application/json', temperature:0}})
  });
  if (res.getResponseCode() >= 300) return null;
  const obj = JSON.parse(res.getContentText());
  const raw = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return null;
  try {
    const out = JSON.parse(raw);
    ['due_date','statement_date','billing_period_start','billing_period_end'].forEach(k => { if (out[k]) out[k] = parseDateLoose_(out[k]); });
    if (out.total_amount_due != null) out.total_amount_due = Number(out.total_amount_due);
    return out;
  } catch(e) { return null; }
}

function applyProductRules_(identity, fields) {
  // Extracted dates are preferred. Rules fill/validate known products when needed.
  const p = identity.product_type;
  const b = String(identity.bank_lender).toLowerCase();
  if (!fields.statement_date && p === 'credit_card') {
    const now = new Date();
    if (b.includes('eastwest')) fields.statement_date = new Date(now.getFullYear(), now.getMonth(), 21);
    if (b.includes('rcbc')) fields.statement_date = new Date(now.getFullYear(), now.getMonth(), 3);
    if (b.includes('unionbank')) fields.statement_date = previousBusinessDay_(new Date(now.getFullYear(), now.getMonth(), 10));
  }
  // Do not overwrite an explicitly extracted due date.
  if (!fields.due_date && fields.statement_date) {
    if (b.includes('eastwest')) {
      let d = new Date(fields.statement_date.getFullYear(), fields.statement_date.getMonth()+1, 15);
      fields.due_date = previousBusinessDay_(d);
    } else if (b.includes('unionbank') && p === 'credit_card') {
      let d = addDays_(fields.statement_date, 17);
      fields.due_date = nextBusinessDay_(d);
    } else if (b.includes('rcbc')) {
      let d = addDays_(fields.statement_date, 25);
      fields.due_date = nextBusinessDay_(d);
    }
  }
  return fields;
}

function isBusinessDay_(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  // Optional calendar lookup. The first calendar whose name contains "Holidays in Philippines" is used.
  const cals = CalendarApp.getAllCalendars().filter(c => /holidays in philippines/i.test(c.getName()));
  if (!cals.length) return true;
  const events = cals[0].getEventsForDay(d);
  return events.length === 0;
}
function previousBusinessDay_(d) { d = new Date(d); while (!isBusinessDay_(d)) d = addDays_(d,-1); return d; }
function nextBusinessDay_(d) { d = new Date(d); while (!isBusinessDay_(d)) d = addDays_(d,1); return d; }

function discoverSource_(identity, sender) {
  const sh = SpreadsheetApp.getActive().getSheetByName(BB.SHEETS.SOURCES);
  const rows = rowsAsObjects_(BB.SHEETS.SOURCES);
  const sourceKey = `${sender.email.toLowerCase()}|${identity.product_type}`;
  let found = rows.find(r => String(r.source_key) === sourceKey);
  if (found) {
    updateRowByKey_(sh, 'source_key', sourceKey, {last_seen_at:new Date()});
    return found;
  }
  const status = String(getSetting_('auto_track_new_sources')).toLowerCase() === 'true' ? 'included' : (getSetting_('unknown_source_default_status') || 'pending');
  const row = {
    source_key:sourceKey, source_name:identity.source_name, sender_email:sender.email,
    sender_domain:sender.domain, bank_lender:identity.bank_lender, product_type:identity.product_type,
    tracking_status:status, reason:'', first_seen_at:new Date(), last_seen_at:new Date()
  };
  appendObject_(sh,row);
  return row;
}

function ensureAccount_(identity, sourceKey) {
  const sh = SpreadsheetApp.getActive().getSheetByName(BB.SHEETS.ACCOUNTS);
  const key = `${identity.bank_lender}|${identity.product_type}`.toLowerCase();
  const rows = rowsAsObjects_(BB.SHEETS.ACCOUNTS);
  let found = rows.find(r => String(r.account_key).toLowerCase() === key);
  if (found) { updateRowByKey_(sh,'account_key',found.account_key,{last_seen_at:new Date()}); return found; }
  const row = {
    account_key:key, bank_lender:identity.bank_lender, product_type:identity.product_type,
    display_name:`${identity.bank_lender} ${humanize_(identity.product_type)}`,
    logo_key:logoKey_(identity.bank_lender), credit_limit:'', utilization_target:0.20,
    tracking_status:'included', active:true, first_seen_at:new Date(), last_seen_at:new Date()
  };
  appendObject_(sh,row);
  return row;
}

function saveBill_(message, account, identity, f, pdfUsed, status, confidence) {
  const sh = SpreadsheetApp.getActive().getSheetByName(BB.SHEETS.BILLS);
  appendObject_(sh, {
    id: Utilities.getUuid(), account_key:account.account_key, bank_lender:identity.bank_lender,
    product_type:identity.product_type, statement_date:f.statement_date || '',
    billing_period_start:f.billing_period_start || '', billing_period_end:f.billing_period_end || '',
    due_date:f.due_date || '', total_amount_due:(f.total_amount_due ?? ''), currency:f.currency || 'PHP',
    gmail_message_id:message.getId(), gmail_subject:message.getSubject() || '',
    sender_email:parseSender_(message.getFrom()).email, pdf_used:pdfUsed,
    processing_status:status, confidence:confidence || '', processed_at:new Date()
  });
}

function billExists_(messageId) {
  return rowsAsObjects_(BB.SHEETS.BILLS).some(r => String(r.gmail_message_id) === String(messageId));
}

function syncAccountsForSource_(sourceKey, status) {
  const sources = rowsAsObjects_(BB.SHEETS.SOURCES);
  const s = sources.find(r => String(r.source_key) === String(sourceKey));
  if (!s) return;
  const key = `${s.bank_lender}|${s.product_type}`.toLowerCase();
  const sh = SpreadsheetApp.getActive().getSheetByName(BB.SHEETS.ACCOUNTS);
  const rows = rowsAsObjects_(BB.SHEETS.ACCOUNTS);
  const a = rows.find(r => String(r.account_key).toLowerCase() === key);
  if (a) updateRowByKey_(sh,'account_key',a.account_key,{tracking_status:status, active:status === 'included'});
}

function ensureSheet_(ss,name,headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,headers.length).setValues([headers]);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
  return sh;
}
function rowsAsObjects_(sheetName) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const h = values[0];
  return values.slice(1).filter(r => r.some(v => v !== '')).map(r => Object.fromEntries(h.map((k,i)=>[k,r[i]])));
}
function appendObject_(sh,obj) {
  const h = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  sh.appendRow(h.map(k => obj[k] === undefined ? '' : obj[k]));
}
function updateRowByKey_(sh,keyName,keyValue,updates) {
  const data = sh.getDataRange().getValues(), h=data[0], kc=h.indexOf(keyName);
  for (let i=1;i<data.length;i++) if (String(data[i][kc]) === String(keyValue)) {
    Object.keys(updates).forEach(k => { const c=h.indexOf(k); if(c>=0) sh.getRange(i+1,c+1).setValue(updates[k]); });
    return;
  }
}
function setSettingIfMissing_(key,value) {
  if (getSetting_(key) !== null) return;
  const sh=SpreadsheetApp.getActive().getSheetByName(BB.SHEETS.SETTINGS); sh.appendRow([key,value]);
}
function getSetting_(key) {
  const rows=rowsAsObjects_(BB.SHEETS.SETTINGS); const x=rows.find(r=>String(r.key)===String(key)); return x ? x.value : null;
}
function getOrCreateLabel_(name) { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }
function parseSender_(from) {
  const m=String(from||'').match(/<([^>]+)>/); const email=(m?m[1]:from).trim().toLowerCase();
  return {email,domain:(email.split('@')[1]||'').toLowerCase()};
}
function titleFromDomain_(d) { if(!d)return ''; const p=d.split('.')[0].replace(/[-_]/g,' '); return p.replace(/\b\w/g,c=>c.toUpperCase()); }
function humanize_(s) { return String(s||'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); }
function logoKey_(bank) {
  const s=String(bank||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const map={unionbank:'unionbank',eastwest:'eastwest',rcbc:'rcbc',bdo:'bdo',bpi:'bpi',chinabank:'chinabank',metrobank:'metrobank',securitybank:'security-bank',maribank:'maribank'};
  return map[s] || '';
}
function parseMoney_(s) { const n=Number(String(s).replace(/,/g,'')); return Number.isFinite(n)?n:null; }
function parseDateLoose_(s) {
  s=String(s||'').trim().replace(/[,.]$/,'');
  const direct=new Date(s); if(!isNaN(direct)) return direct;
  const m=s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if(m){ let y=Number(m[3]); if(y<100)y+=2000; const d=new Date(y,Number(m[1])-1,Number(m[2])); if(!isNaN(d))return d; }
  return null;
}
function mergeFields_(a,b) { const out=Object.assign({},a); Object.keys(b||{}).forEach(k=>{ if((out[k]===undefined||out[k]===null||out[k]==='') && b[k]!==undefined && b[k]!==null && b[k]!=='') out[k]=b[k]; }); return out; }
function stripHtml_(h) { return String(h).replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&'); }
function addDays_(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function startOfDay_(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
