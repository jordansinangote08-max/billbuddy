const state = {
  dashboard: { summary: {}, bills: [] },
  limits: []
};

const peso = value =>
  "₱" + Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function parseDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function formatDate(value) {
  const d = parseDate(value);
  return d ? d.toLocaleDateString("en-PH", {month:"short", day:"numeric", year:"numeric"}) : "—";
}

function productName(value) {
  return String(value || "bill").replaceAll("_"," ").replace(/\b\w/g, c => c.toUpperCase());
}

function daysUntil(value) {
  const due = parseDate(value);
  if (!due) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

function dueLabel(value) {
  const n = daysUntil(value);
  if (n === null) return "Due date unavailable";
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  return `Due in ${n} days`;
}

function bankLogo(bank) {
  const key = String(bank || "").toLowerCase().replace(/[^a-z0-9]/g,"");
  const logos = {
    unionbank:"unionbank.png",
    rcbc:"rcbc.png",
    eastwest:"eastwest.png",
    bdo:"bdo.png",
    bpi:"bpi.png",
    chinabank:"chinabank.png",
    metrobank:"metrobank.png",
    maribank:"maribank.png",
    securitybank:"security-bank.png"
  };
  return logos[key] ? `/static/logos/${logos[key]}` : "";
}

function logoHtml(bank) {
  const src = bankLogo(bank);
  const initials = esc(String(bank || "?").slice(0,2).toUpperCase());
  return src
    ? `<img src="${src}" alt="${esc(bank)} logo" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span class="fallback" style="display:none">${initials}</span>`
    : initials;
}

function utilizationHtml(bill) {
  if (String(bill.product_type).toLowerCase() !== "credit_card") return "";

  if (!bill.credit_limit || bill.utilization_rate === null) {
    return `
      <div class="util-card missing">
        <div>
          <b>Utilization</b>
          <span>Add a credit limit to calculate it.</span>
        </div>
        <button class="mini-link" onclick="openLimits()">Set limit</button>
      </div>
    `;
  }

  const rate = Number(bill.utilization_rate);
  const target = Number(bill.utilization_target || 0.20);
  const pct = Math.max(0, rate * 100);
  const status = bill.utilization_status || "good";
  const ringPct = Math.min(100, pct);

  return `
    <div class="util-card ${status}">
      <div class="util-ring" style="--pct:${ringPct}">
        <div><strong>${pct.toFixed(1)}%</strong><span>used</span></div>
      </div>
      <div class="util-copy">
        <b>Credit utilization</b>
        <span>${peso(bill.total_amount_due)} of ${peso(bill.credit_limit)}</span>
      </div>
    </div>
  `;
}

async function fetchJson(url, options={}) {
  const response = await fetch(url, {cache:"no-store", ...options});
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("BillBuddy received an invalid server response.");
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || "BillBuddy request failed.");
  }
  return payload;
}

async function loadDashboard() {
  try {
    const payload = await fetchJson("/api/dashboard");
    state.dashboard = payload.data || {summary:{},bills:[]};
    renderDashboard();
  } catch (error) {
    showStatus("statusBox", error.message, true);
  }
}

async function loadLimits() {
  try {
    const payload = await fetchJson("/api/credit-limits");
    state.limits = payload.data || [];
    renderLimits();
    showStatus("limitsStatus", "");
  } catch (error) {
    showStatus("limitsStatus", error.message, true);
  }
}

function renderDashboard() {
  const data = state.dashboard;
  const bills = [...(data.bills || [])].sort((a,b)=>parseDate(a.due_date)-parseDate(b.due_date));
  document.getElementById("totalAmount").textContent = peso(data.summary?.totalAmountDue);
  document.getElementById("billCount").textContent = data.summary?.upcomingBills ?? bills.length;
  document.getElementById("totalCaption").textContent = bills.length ? `${bills.length} payment${bills.length===1?"":"s"} ahead` : "Nothing due";
  document.getElementById("nextDue").textContent = bills.length ? formatDate(bills[0].due_date) : "—";
  document.getElementById("nextDueCaption").textContent = bills.length ? `${bills[0].bank_lender} · ${dueLabel(bills[0].due_date)}` : "No upcoming bill";
  document.getElementById("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}`;

  const grid = document.getElementById("billGrid");
  grid.innerHTML = bills.length ? bills.map(bill => `
    <article class="bill-card">
      <div class="bill-top">
        <div class="logo">${logoHtml(bill.bank_lender)}</div>
        <div><div class="bank">${esc(bill.bank_lender)}</div><div class="muted">${esc(productName(bill.product_type))}</div></div>
      </div>
      <div class="amount">${peso(bill.total_amount_due)}</div>
      <div class="due-row">
        <div><span class="muted">Payment due</span><strong>${formatDate(bill.due_date)}</strong></div>
        <span class="due-pill">${esc(dueLabel(bill.due_date))}</span>
      </div>
      <div class="statement">Statement ${formatDate(bill.statement_date)}</div>
      ${utilizationHtml(bill)}
    </article>
  `).join("") : `<div class="empty">No upcoming processed bills.</div>`;

  showStatus("statusBox", "");
}

function renderLimits() {
  const grid = document.getElementById("creditLimitGrid");

  if (!state.limits.length) {
    grid.innerHTML = `<div class="empty">No credit card accounts found yet.</div>`;
    return;
  }

  grid.innerHTML = state.limits.map(card => `
    <article class="limit-card">
      <div class="bill-top">
        <div class="logo">${logoHtml(card.bank_lender)}</div>
        <div><div class="bank">${esc(card.bank_lender)}</div><div class="muted">${esc(card.display_name || "Credit Card")}</div></div>
      </div>

      <label>Credit limit</label>
      <div class="money-input">
        <span>₱</span>
        <input id="limit-${esc(card.account_key)}" type="number" min="1" step="0.01" value="${card.credit_limit || ""}" placeholder="Enter credit limit">
      </div>

      <label>Utilization target</label>
      <div class="target-row">
        <input id="target-${esc(card.account_key)}" type="number" min="1" max="100" step="1" value="${Math.round(Number(card.utilization_target || 0.20)*100)}">
        <span>%</span>
      </div>

      <button class="save-button" onclick="saveLimit('${esc(card.account_key)}')">Save</button>
    </article>
  `).join("");
}

async function saveLimit(accountKey) {
  const limit = document.getElementById(`limit-${accountKey}`).value;
  const target = document.getElementById(`target-${accountKey}`).value;

  try {
    showStatus("limitsStatus", "Saving…");
    await fetchJson("/api/credit-limits", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        account_key: accountKey,
        credit_limit: Number(limit),
        utilization_target: Number(target)
      })
    });
    showStatus("limitsStatus", "Credit limit saved.");
    await Promise.all([loadLimits(), loadDashboard()]);
  } catch (error) {
    showStatus("limitsStatus", error.message, true);
  }
}

function showStatus(id, message, error=false) {
  const el = document.getElementById(id);
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
  el.classList.toggle("error", error);
}

function switchPage(page) {
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active", b.dataset.page===page));
  document.getElementById("paymentsPage").classList.toggle("active", page==="payments");
  document.getElementById("limitsPage").classList.toggle("active", page==="limits");
  document.getElementById("pageTitle").textContent = page==="payments" ? "Upcoming payments" : "Credit limits";
  document.getElementById("pageSubtitle").textContent = page==="payments" ? "Your next bills, sorted by due date." : "Edit credit limits and keep card utilization near your 20% target.";
  if (page==="limits") loadLimits();
}

function openLimits() {
  switchPage("limits");
  window.scrollTo({top:0,behavior:"smooth"});
}

document.querySelectorAll(".tab").forEach(button=>{
  button.addEventListener("click",()=>switchPage(button.dataset.page));
});

document.getElementById("refreshButton").addEventListener("click", async ()=>{
  await Promise.all([loadDashboard(), state.limits.length ? loadLimits() : Promise.resolve()]);
});

loadDashboard();
