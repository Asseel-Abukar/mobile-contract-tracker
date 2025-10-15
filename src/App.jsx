import React, { useEffect, useMemo, useRef, useState } from "react";
// If you want emails without a backend, install EmailJS SDK:
//   npm i @emailjs/browser
// Then fill in your EmailJS credentials in Settings inside the app UI.
// Alternatively, wire a serverless email (e.g., Vercel + Resend) — hooks included below.

// =============================
// Helpers
// =============================
function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  const start = new Date(a).setHours(0, 0, 0, 0);
  const end = new Date(b).setHours(0, 0, 0, 0);
  return Math.round((end - start) / MS);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const STORAGE_KEY = "mobile-contract-tracker:v2";
const SETTINGS_KEY = "mobile-contract-tracker:settings";
const NOTIFIED_KEY = "mobile-contract-tracker:notified"; // prevent duplicate emails

const emptyRow = () => ({
  id: crypto.randomUUID(),
  phone: "",
  label: "",
  startDate: "",
  endDate: "",
  costMonthly: "",
  notes: "",
});

const numberFmt = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 2,
});

// =============================
// Email helpers (top-level so we can test them)
// =============================
const emailSubject = (row) =>
  `Contract expiring: ${row.phone || row.label || "(unnamed)"} in ${row.daysLeft} day${
    row.daysLeft === 1 ? "" : "s"
  }`;

const emailBody = (row) => {
  const lines = [
    `SIM: ${row.phone || row.label || "(unnamed)"}`,
    row.label ? `Label: ${row.label}` : null,
    row.endDate ? `End Date: ${row.endDate}` : null,
    Number.isFinite(row.daysLeft) ? `Days Left: ${row.daysLeft}` : null,
    row.cost ? `Monthly Cost: ${numberFmt.format(row.cost)}` : null,
    row.notes ? `Notes: ${row.notes}` : null,
  ].filter(Boolean);
  // IMPORTANT: use \n (newline) to join; avoids unterminated string errors
  return lines.join("\n");
};

// =============================
// UI atoms
// =============================
const StatusBadge = ({ daysLeft }) => {
  const base =
    "inline-flex items-center gap-2 px-2 py-1 text-xs font-medium rounded-full ring-1";
  if (Number.isNaN(daysLeft))
    return (
      <span className={`${base} bg-slate-100 ring-slate-200 text-slate-600`}>—</span>
    );
  if (daysLeft < 0)
    return (
      <span className={`${base} bg-red-50 ring-red-200 text-red-700`}>Expired</span>
    );
  if (daysLeft <= 7)
    return (
      <span className={`${base} bg-orange-50 ring-orange-200 text-orange-700`}>
        Urgent
      </span>
    );
  if (daysLeft <= 30)
    return (
      <span className={`${base} bg-yellow-50 ring-yellow-200 text-yellow-700`}>
        Expiring
      </span>
    );
  return (
    <span className={`${base} bg-emerald-50 ring-emerald-200 text-emerald-700`}>
      Active
    </span>
  );
};

const Progress = ({ startDate, endDate }) => {
  if (!startDate || !endDate)
    return <div className="h-2 bg-slate-100 rounded-full" />;
  const total = Math.max(1, daysBetween(startDate, endDate));
  const used = daysBetween(startDate, new Date());
  const pct = clamp(Math.round((used / total) * 100), 0, 100);
  return (
    <div className="w-40">
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-slate-500">{pct}% of term elapsed</div>
    </div>
  );
};

// =============================
// Email sending utilities
// =============================
async function sendEmailViaEmailJS({
  serviceId,
  templateId,
  publicKey,
  toEmail,
  subject,
  message,
}) {
  // dynamic import so the app still works if SDK isn't installed yet
  const emailjs = await import("@emailjs/browser").catch(() => null);
  if (!emailjs)
    throw new Error("EmailJS SDK not installed. Run: npm i @emailjs/browser");
  return emailjs.send(
    serviceId,
    templateId,
    { to_email: toEmail, subject, message },
    { publicKey }
  );
}

// (Optional) Hook for serverless email — drop in your endpoint URL below
async function sendEmailViaWebhook({ endpoint, toEmail, subject, message }) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: toEmail, subject, text: message }),
  });
  if (!res.ok) throw new Error(`Email webhook failed: ${res.status}`);
  return await res.json();
}

export default function ContractTracker() {
  // =============================
  // State
  // =============================
  const [rows, setRows] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [emptyRow()];
    } catch {
      return [emptyRow()];
    }
  });

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("daysLeft");
  const [sortDir, setSortDir] = useState("asc");
  const fileInputRef = useRef(null);

  const [settings, setSettings] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {
          notifyEmail: "",
          provider: "emailjs", // "emailjs" | "webhook"
          emailjsServiceId: "",
          emailjsTemplateId: "",
          emailjsPublicKey: "",
          webhookEndpoint: "",
          thresholds: [30, 7, 1, 0],
        }
      );
    } catch {
      return { notifyEmail: "", provider: "emailjs", thresholds: [30, 7, 1, 0] };
    }
  });

  const [notified, setNotified] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(NOTIFIED_KEY)) || {};
    } catch {
      return {};
    }
  });

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)), [rows]);
  useEffect(
    () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)),
    [settings]
  );
  useEffect(
    () => localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified)),
    [notified]
  );

  // =============================
  // Derived
  // =============================
  const enriched = useMemo(() => {
    const today = new Date();
    return rows.map((r) => {
      const daysLeft = r.endDate ? daysBetween(today, r.endDate) : NaN;
      const cost = r.costMonthly ? Number(r.costMonthly) : 0;
      return { ...r, daysLeft, cost };
    });
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = enriched;
    const list = q
      ? base.filter((r) =>
          [r.phone, r.label, r.notes]
            .some((x) => (x || "").toLowerCase().includes(q))
        )
      : base;
    const sorted = [...list].sort((a, b) => {
      let A = a[sortBy];
      let B = b[sortBy];
      if (A === undefined) A = "";
      if (B === undefined) B = "";
      if (typeof A === "string") A = A.toLowerCase();
      if (typeof B === "string") B = B.toLowerCase();
      if (A < B) return sortDir === "asc" ? -1 : 1;
      if (A > B) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [enriched, search, sortBy, sortDir]);

  const totals = useMemo(() => {
    const monthly = enriched.reduce(
      (sum, r) => sum + (Number(r.costMonthly) || 0),
      0
    );
    return { monthly };
  }, [enriched]);

  // =============================
  // Notifications & Email Reminders
  // =============================
  useEffect(() => {
    const thresholds = settings.thresholds || [30, 7, 1, 0];

    const shouldSendFor = (row, t) =>
      Number.isFinite(row.daysLeft) && row.daysLeft === t;

    const keyFor = (row, t) => `${row.id}:${t}`;

    const sendEmail = async (row) => {
      const subject = emailSubject(row);
      const message = emailBody(row);
      const toEmail = settings.notifyEmail?.trim();
      if (!toEmail) return;

      if (settings.provider === "webhook" && settings.webhookEndpoint) {
        await sendEmailViaWebhook({
          endpoint: settings.webhookEndpoint,
          toEmail,
          subject,
          message,
        });
        return;
      }
      if (settings.provider === "emailjs") {
        const { emailjsServiceId, emailjsTemplateId, emailjsPublicKey } =
          settings;
        if (!emailjsServiceId || !emailjsTemplateId || !emailjsPublicKey)
          return;
        await sendEmailViaEmailJS({
          serviceId: emailjsServiceId,
          templateId: emailjsTemplateId,
          publicKey: emailjsPublicKey,
          toEmail,
          subject,
          message,
        });
        return;
      }
    };

    const checkExpiries = async () => {
      for (const row of filtered) {
        for (const t of thresholds) {
          if (shouldSendFor(row, t)) {
            const k = keyFor(row, t);
            if (!notified[k]) {
              try {
                await sendEmail(row);
                setNotified((prev) => ({
                  ...prev,
                  [k]: new Date().toISOString(),
                }));
              } catch (e) {
                console.warn("Email send failed:", e);
              }
            }
          }
        }
      }
    };

    const id = setInterval(checkExpiries, 60 * 60 * 1000); // hourly
    checkExpiries();
    return () => clearInterval(id);
  }, [filtered, settings, notified]);

  // =============================
  // Actions
  // =============================
  const addRow = () => setRows((r) => [...r, emptyRow()]);
  const addBulk = (n = 10) =>
    setRows((r) => [...r, ...Array.from({ length: n }, emptyRow)]);
  const deleteRow = (id) => setRows((r) => r.filter((x) => x.id !== id));
  const clearAll = () => {
    if (confirm("Clear all rows? This cannot be undone.")) setRows([emptyRow()]);
  };
  const updateCell = (id, key, value) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));

  const exportCSV = () => {
    const cols = [
      "phone",
      "label",
      "startDate",
      "endDate",
      "costMonthly",
      "notes",
    ];
    const lines = [cols.join(",")].concat(
      rows.map((r) =>
        cols
          .map((c) => (r[c] ?? "").toString().replaceAll('"', '""'))
          .join(",")
      )
    );
    // IMPORTANT: always join rows with \n
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mobile-contracts-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importCSV = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target?.result || "");
      // IMPORTANT: split on CRLF or LF
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const header = lines[0].split(",").map((h) => h.trim());
      const idx = {
        phone: header.indexOf("phone"),
        label: header.indexOf("label"),
        startDate: header.indexOf("startDate"),
        endDate: header.indexOf("endDate"),
        costMonthly: header.indexOf("costMonthly"),
        notes: header.indexOf("notes"),
      };
      const parsed = lines.slice(1).map((line) => {
        const parts = line.split(",");
        return {
          id: crypto.randomUUID(),
          phone: parts[idx.phone] || "",
          label: parts[idx.label] || "",
          startDate: parts[idx.startDate] || "",
          endDate: parts[idx.endDate] || "",
          costMonthly: parts[idx.costMonthly] || "",
          notes: parts[idx.notes] || "",
        };
      });
      setRows((r) => [...r, ...parsed]);
    };
    reader.readAsText(file);
  };

  const expiringSummary = () => {
    const soon = enriched
      .filter((r) => Number.isFinite(r.daysLeft) && r.daysLeft <= 30)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .map(
        (r) =>
          `• ${r.phone || r.label || "(unnamed)"} — ${r.daysLeft} days left (ends ${
            r.endDate
          })`
      )
      .join("%0A");
    return encodeURIComponent(
      soon || "No lines expiring in the next 30 days."
    );
  };

  const mailtoHref = () => {
    const subject = encodeURIComponent("Mobile contracts expiring soon");
    const body = expiringSummary();
    return `mailto:?subject=${subject}&body=${body}`;
  };

  // =============================
  // UI
  // =============================
  const headers = [
    { key: "phone", label: "Phone Number" },
    { key: "label", label: "Label" },
    { key: "startDate", label: "Start Date" },
    { key: "endDate", label: "End Date" },
    { key: "costMonthly", label: "£ / month" },
    { key: "daysLeft", label: "Days Left" },
    { key: "status", label: "Status" },
    { key: "progress", label: "Progress" },
    { key: "notes", label: "Notes" },
  ];

  const setSort = (key) => {
    if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir("asc");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 via-white to-slate-50 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600 text-white grid place-items-center text-xl shadow">
              📱
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                Mobile Contract Tracker
              </h1>
              <p className="text-xs text-slate-500">
                Track start & end dates, costs, and get email alerts before
                expiry.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={() => setSettingsOpen(true)}
              className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
            >
              ⚙️ Settings
            </button>
            <a
              href={mailtoHref()}
              className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
            >
              📧 Email me expiring list
            </a>
            <button
              onClick={exportCSV}
              className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
            >
              ⬇️ Export CSV
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
            >
              ⬆️ Import CSV
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) =>
                e.target.files && e.target.files[0] && importCSV(e.target.files[0])
              }
            />
            <button
              onClick={() => addBulk(10)}
              className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
            >
              +10 rows
            </button>
            <button
              onClick={addRow}
              className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
            >
              +1 row
            </button>
            <button
              onClick={clearAll}
              className="px-3 py-2 rounded-xl ring-1 ring-red-200 bg-white hover:bg-red-50 text-red-700 shadow-sm"
            >
              Clear all
            </button>
          </div>
        </div>
      </header>

      {/* KPIs */}
      <main className="max-w-7xl mx-auto p-4">
        <section className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-sm text-slate-500">Total monthly cost</div>
            <div className="text-3xl font-semibold">
              {numberFmt.format(totals.monthly || 0)}
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-sm text-slate-500">Lines tracked</div>
            <div className="text-3xl font-semibold">{rows.length}</div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-sm text-slate-500">Expiring ≤ 30 days</div>
            <div className="text-3xl font-semibold">
              {
                enriched.filter(
                  (r) => Number.isFinite(r.daysLeft) && r.daysLeft <= 30
                ).length
              }
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="text-sm text-slate-500">Average £/month</div>
            <div className="text-3xl font-semibold">
              {rows.length
                ? numberFmt.format((totals.monthly || 0) / rows.length)
                : numberFmt.format(0)}
            </div>
          </div>
        </section>

        {/* Controls */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Search phone, label, or notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full md:w-80 px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
          />
          <div className="text-sm text-slate-500">Sort by:</div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
          >
            <option value="daysLeft">Days Left</option>
            <option value="endDate">End Date</option>
            <option value="phone">Phone Number</option>
            <option value="label">Label</option>
            <option value="cost">£ / month</option>
          </select>
          <button
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
          >
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>

        {/* Table */}
        <div className="overflow-auto rounded-2xl shadow ring-1 ring-black/5 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                {headers.map((h) => (
                  <th
                    key={h.key}
                    className="text-left font-semibold px-3 py-2 cursor-pointer select-none"
                    onClick={() => setSort(h.key)}
                  >
                    {h.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-t align-top hover:bg-slate-50/50"
                >
                  <td className="px-3 py-2">
                    <input
                      className="w-44 md:w-52 px-2 py-1 rounded-lg ring-1 ring-slate-200 bg-white"
                      value={r.phone}
                      placeholder="07…"
                      onChange={(e) => updateCell(r.id, "phone", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="w-40 md:w-48 px-2 py-1 rounded-lg ring-1 ring-slate-200 bg-white"
                      value={r.label}
                      placeholder="e.g., John Work iPhone"
                      onChange={(e) => updateCell(r.id, "label", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="date"
                      className="px-2 py-1 rounded-lg ring-1 ring-slate-200 bg-white"
                      value={r.startDate}
                      onChange={(e) => updateCell(r.id, "startDate", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="date"
                      className="px-2 py-1 rounded-lg ring-1 ring-slate-200 bg-white"
                      value={r.endDate}
                      onChange={(e) => updateCell(r.id, "endDate", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      className="w-28 px-2 py-1 rounded-lg ring-1 ring-slate-200 bg-white"
                      placeholder="0.00"
                      value={r.costMonthly}
                      onChange={(e) => updateCell(r.id, "costMonthly", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap align-middle">
                    {Number.isFinite(r.daysLeft) ? r.daysLeft : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap align-middle">
                    <StatusBadge daysLeft={r.daysLeft} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap align-middle">
                    <Progress startDate={r.startDate} endDate={r.endDate} />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="w-64 md:w-80 px-2 py-1 rounded-lg ring-1 ring-slate-200 bg-white"
                      placeholder="Notes (network, data, etc.)"
                      value={r.notes}
                      onChange={(e) => updateCell(r.id, "notes", e.target.value)}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => deleteRow(r.id)}
                      className="px-2 py-1 rounded-lg ring-1 ring-red-200 bg-white hover:bg-red-50 text-red-700"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={headers.length + 1}
                    className="px-3 py-10 text-center text-slate-500"
                  >
                    No rows match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-slate-500">
          Tip: Add 80+ phone numbers easily. Use Import CSV for bulk entry (columns:
          phone,label,startDate,endDate,costMonthly,notes).
        </p>
      </main>

      <footer className="max-w-7xl mx-auto px-4 pb-10 pt-6 text-xs text-slate-500">
        Emails are sent at the exact day thresholds you configure (default:
        30/7/1/0 days). To send while the app is closed, deploy a serverless
        webhook and set provider to "webhook" in Settings.
      </footer>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSettingsOpen(false)}
          />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[min(720px,92vw)] p-6">
            <h2 className="text-xl font-semibold mb-2">Settings</h2>
            <p className="text-sm text-slate-500 mb-4">
              Configure email reminders and thresholds.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-xs text-slate-500 mb-1">
                  Send reminders to
                </label>
                <input
                  value={settings.notifyEmail}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, notifyEmail: e.target.value }))
                  }
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Provider
                </label>
                <select
                  value={settings.provider}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, provider: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                >
                  <option value="emailjs">EmailJS (no backend)</option>
                  <option value="webhook">Serverless webhook</option>
                </select>
              </div>

              {settings.provider === "emailjs" && (
                <>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      EmailJS Service ID
                    </label>
                    <input
                      value={settings.emailjsServiceId}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          emailjsServiceId: e.target.value,
                        }))
                      }
                      placeholder="service_xxx"
                      className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      EmailJS Template ID
                    </label>
                    <input
                      value={settings.emailjsTemplateId}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          emailjsTemplateId: e.target.value,
                        }))
                      }
                      placeholder="template_xxx"
                      className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">
                      EmailJS Public Key
                    </label>
                    <input
                      value={settings.emailjsPublicKey}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          emailjsPublicKey: e.target.value,
                        }))
                      }
                      placeholder="YOUR_PUBLIC_KEY"
                      className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      EmailJS template variables used: <code>to_email, subject,
                        message</code>.
                    </p>
                  </div>
                </>
              )}

              {settings.provider === "webhook" && (
                <div className="sm:col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">
                    Webhook endpoint (POST JSON: {`{ to, subject, text }`})
                  </label>
                  <input
                    value={settings.webhookEndpoint}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        webhookEndpoint: e.target.value,
                      }))
                    }
                    placeholder="https://your-function.vercel.app/api/send"
                    className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                  />
                </div>
              )}

              <div className="sm:col-span-2">
                <label className="block text-xs text-slate-500 mb-1">
                  Email thresholds (days left)
                </label>
                <input
                  value={(settings.thresholds || []).join(",")}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      thresholds: e.target.value
                        .split(",")
                        .map((x) => parseInt(x.trim(), 10))
                        .filter((n) => !Number.isNaN(n)),
                    }))
                  }
                  placeholder="30,7,1,0"
                  className="w-full px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white shadow-sm"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setSettingsOpen(false)}
                className="px-3 py-2 rounded-xl ring-1 ring-slate-200 bg-white hover:bg-slate-50 shadow-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================
// DEV SMOKE TESTS (run in browser console)
// These are lightweight checks to prevent regressions in string handling.
// They do not affect app behavior if they fail; they only log warnings.
// =============================
(function runDevSmokeTests() {
  try {
    const row = {
      phone: "07123456789",
      label: "Test Line",
      endDate: "2030-01-01",
      daysLeft: 7,
      cost: 12.34,
      notes: "Sample",
    };
    const body = emailBody(row);
    console.assert(
      body.includes("\n"),
      "emailBody should join lines with newline (\\n)"
    );

    const csv = ["a,b", "c,d"].join("\n");
    console.assert(
      csv.split(/\r?\n/).length === 2,
      "CSV should use and parse newline correctly"
    );

    console.assert(
      daysBetween("2020-01-01", "2020-01-02") === 1,
      "daysBetween basic increment"
    );
  } catch (e) {
    console.warn("Dev smoke tests failed:", e);
  }
})();
