const state = {
  data: {
    summary: {},
    bills: []
  }
};

const peso = (value) =>
  "₱" +
  Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

function parseDate(value) {
  if (!value) return null;

  // API returns yyyy-mm-dd. Use local-midnight construction
  // to avoid timezone shifting in the browser.
  const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (iso) {
    return new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3])
    );
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);

  return date
    ? date.toLocaleDateString("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
      })
    : "—";
}

function productName(value) {
  return String(value || "bill")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function daysUntil(value) {
  const due = parseDate(value);

  if (!due) return null;

  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  return Math.round(
    (due.getTime() - today.getTime()) / 86400000
  );
}

function dueLabel(value) {
  const days = daysUntil(value);

  if (days === null) {
    return {
      text: "Due date unavailable",
      soon: false
    };
  }

  if (days === 0) {
    return {
      text: "Due today",
      soon: true
    };
  }

  if (days === 1) {
    return {
      text: "Due tomorrow",
      soon: true
    };
  }

  return {
    text: `Due in ${days} days`,
    soon: days <= 5
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]
  );
}

function showStatus(message, isError = false) {
  const box = document.getElementById("statusBox");

  if (!message) {
    box.classList.add("hidden");
    box.classList.remove("error");
    box.textContent = "";
    return;
  }

  box.textContent = message;
  box.classList.remove("hidden");
  box.classList.toggle("error", isError);
}

async function loadDashboard() {
  const button = document.getElementById("refreshButton");

  button.disabled = true;
  button.textContent = "Refreshing…";
  showStatus("Loading your upcoming bills…");

  try {
    const response = await fetch("/api/dashboard", {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const payload = await response.json();

    if (!response.ok || payload.ok !== true) {
      throw new Error(
        payload.error || "Unable to load BillBuddy data."
      );
    }

    state.data = payload.data || {
      summary: {},
      bills: []
    };

    render();
    showStatus("");

    document.getElementById("lastUpdated").textContent =
      `Updated ${new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })}`;
  } catch (error) {
    showStatus(
      error.message || "Unable to load BillBuddy data.",
      true
    );
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

function render() {
  const summary = state.data.summary || {};
  const bills = [...(state.data.bills || [])].sort(
    (a, b) =>
      parseDate(a.due_date) - parseDate(b.due_date)
  );

  document.getElementById("totalAmount").textContent =
    peso(summary.totalAmountDue);

  document.getElementById("billCount").textContent =
    summary.upcomingBills ?? bills.length;

  document.getElementById("totalCaption").textContent =
    bills.length
      ? `${bills.length} payment${bills.length === 1 ? "" : "s"} ahead`
      : "Nothing due right now";

  if (bills.length) {
    document.getElementById("nextDue").textContent =
      formatDate(bills[0].due_date);

    document.getElementById("nextDueCaption").textContent =
      `${bills[0].bank_lender} · ${dueLabel(bills[0].due_date).text}`;
  } else {
    document.getElementById("nextDue").textContent = "—";
    document.getElementById("nextDueCaption").textContent =
      "No upcoming bill";
  }

  renderCards(bills);
  renderTable(bills);
}

function renderCards(bills) {
  const grid = document.getElementById("billGrid");

  if (!bills.length) {
    grid.innerHTML = `
      <div class="bill-card">
        <div class="bill-bank">You’re clear for now.</div>
        <div class="bill-product">No upcoming processed bills.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = bills
    .map((bill) => {
      const label = dueLabel(bill.due_date);
      const bank = bill.bank_lender || "Unknown";

      return `
        <article class="bill-card">
          <div class="bill-top">
            <div class="logo">
              ${escapeHtml(bank.slice(0, 2).toUpperCase())}
            </div>
            <div>
              <div class="bill-bank">${escapeHtml(bank)}</div>
              <div class="bill-product">
                ${escapeHtml(productName(bill.product_type))}
              </div>
            </div>
          </div>

          <div class="bill-amount">
            ${escapeHtml(peso(bill.total_amount_due))}
          </div>

          <div class="due-row">
            <div>
              <div class="bill-product">Payment due</div>
              <div class="due-date">
                ${escapeHtml(formatDate(bill.due_date))}
              </div>
            </div>

            <span class="badge ${label.soon ? "soon" : ""}">
              ${escapeHtml(label.text)}
            </span>
          </div>

          <div class="statement-date">
            Statement ${escapeHtml(formatDate(bill.statement_date))}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTable(bills) {
  const body = document.getElementById("billTableBody");
  const empty = document.getElementById("emptyTable");

  if (!bills.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  body.innerHTML = bills
    .map(
      (bill) => `
        <tr>
          <td>${escapeHtml(bill.bank_lender)}</td>
          <td>${escapeHtml(productName(bill.product_type))}</td>
          <td>${escapeHtml(peso(bill.total_amount_due))}</td>
          <td>${escapeHtml(formatDate(bill.due_date))}</td>
          <td>${escapeHtml(formatDate(bill.statement_date))}</td>
        </tr>
      `
    )
    .join("");
}

document
  .getElementById("refreshButton")
  .addEventListener("click", loadDashboard);

loadDashboard();
