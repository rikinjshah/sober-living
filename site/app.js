// Shared helpers for the sign-in, portal and staff pages.
const cfg = window.APP_CONFIG || {};
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const fmtDate = (d) => d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const fmtDateTime = (d) => d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const hm = (m) => m == null ? "–" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
const METHOD = { urine_cup: "Urine cup", urine_lab: "Urine, lab", oral_swab: "Oral swab", breathalyzer: "Breathalyzer", other: "Other" };

function resultPill(t) {
  if (t.result === "positive" && t.prescribed_explained) return `<span class="res prescribed">Prescribed medication</span>`;
  const label = { negative: "Negative", positive: "Positive", dilute: "Dilute", invalid: "Invalid", refused: "Refused", pending: "Pending" }[t.result] || t.result;
  return `<span class="res ${esc(t.result)}">${label}</span>`;
}

async function fnCall(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${session?.access_token ?? ""}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

// Sends to /login if not signed in; returns the session otherwise.
async function requireSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace("/login?next=" + encodeURIComponent(location.pathname + location.search)); return null; }
  return session;
}

function wireSignOut() {
  const b = $("signout");
  if (b) b.onclick = async () => { await sb.auth.signOut(); location.href = "/"; };
}

// Bar chart of hours slept; bars under 7h use the warning colour.
function sleepChart(days) {
  const rows = days.filter((d) => d.total_sleep_min != null);
  if (!rows.length) return `<p class="small">No sleep data yet.</p>`;
  const w = 720, h = 120, bw = w / rows.length, max = 10 * 60;
  let s = `<svg viewBox="0 0 ${w} ${h + 20}" role="img" aria-label="Hours of sleep per night">`;
  for (const hr of [6, 8]) { const y = h - (hr * 60 / max) * h; s += `<line x1="0" x2="${w}" y1="${y}" y2="${y}"></line><text x="2" y="${y - 3}">${hr}h</text>`; }
  rows.forEach((d, i) => {
    const bh = Math.min(d.total_sleep_min, max) / max * h;
    s += `<rect class="bar${d.total_sleep_min < 420 ? " low" : ""}" x="${i * bw + 2}" y="${h - bh}" width="${Math.max(bw - 4, 2)}" height="${bh}" rx="2"><title>${fmtDate(d.day)}: ${hm(d.total_sleep_min)}${d.sleep_score ? ", score " + d.sleep_score : ""}</title></rect>`;
  });
  s += `<text x="0" y="${h + 16}">${fmtDate(rows[0].day)}</text><text x="${w}" y="${h + 16}" text-anchor="end">${fmtDate(rows[rows.length - 1].day)}</text></svg>`;
  return s;
}

function avg(arr, k) {
  const v = arr.map((d) => d[k]).filter((x) => x != null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
