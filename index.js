// index.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- WooCommerce config via env ---
const WC_URL    = process.env.WC_URL || "";     // ex: https://.../wp-json/wc/v3/
const WC_KEY    = process.env.WC_KEY || "";     // ck_...
const WC_SECRET = process.env.WC_SECRET || "";  // cs_...

// --- Health check ---
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam & Styles", version: 1 });
});

// --- Debug (ne révèle pas la valeur du token) ---
app.get("/debug-auth", (_req, res) => {
  const isSet = !!(process.env.MCP_TOKEN && String(process.env.MCP_TOKEN).length > 0);
  res.json({ MCP_TOKEN_defined: isSet });
});

// --- Auth Bearer globale (si MCP_TOKEN défini) -----------------------
// On laisse passer les pages HTML publiques: "/", "/dashboard", "/accounting-dashboard", "/debug-auth"
app.use((req, res, next) => {
  const token = process.env.MCP_TOKEN || "";
  if (!token) return next(); // pas de token => aucune auth requise

  const openPaths = new Set(["/", "/dashboard", "/accounting-dashboard", "/debug-auth"]);
  if (openPaths.has(req.path)) return next();

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// --------------------------------------------------------------------
// --------------------- UTILITAIRES WOO ------------------------------
// --------------------------------------------------------------------

function requireWoo() {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set");
  }
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// Récupère une page simple d'orders
async function fetchWooOrders({ status = "processing", per_page = 10 }) {
  requireWoo();
  const pp = clampInt(per_page, 1, 50, 10);
  const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${pp}`;
  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000
  });
  const arr = Array.isArray(data) ? data : [];
  return arr.map(o => ({
    id:           o.id,
    number:       o.number,
    total:        o.total,
    currency:     o.currency,
    date_created: o.date_created,
    status:       o.status,
    customer:     `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
    city:         o.shipping?.city || ""
  }));
}

// Pagination (utilisée pour la compta)
async function fetchOrdersPaged({ status, afterISO, beforeISO }) {
  requireWoo();
  const results = [];
  const per_page = 100; // max Woo
  let page = 1;

  while (true) {
    const url =
      `${WC_URL}orders?status=${encodeURIComponent(status)}` +
      `&per_page=${per_page}&page=${page}` +
      `&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`;

    const { data, headers } = await axios.get(url, {
      auth: { username: WC_KEY, password: WC_SECRET },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 300
    });

    const arr = Array.isArray(data) ? data : [];
    results.push(...arr);

    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

async function fetchRefundsForOrder(orderId) {
  requireWoo();
  const url = `${WC_URL}orders/${orderId}/refunds`;
  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000
  });
  return Array.isArray(data) ? data : [];
}

function monthKey(dateStr) {
  // "2025-10-06T04:39:44" -> "2025-10"
  return (dateStr || "").slice(0, 7);
}

// --------------------------------------------------------------------
// ------------------------- API DASHBOARD ----------------------------
// --------------------------------------------------------------------

app.get("/orders", async (req, res) => {
  try {
    const status = (req.query.status || "processing").toString();
    const per_page = (req.query.per_page || "10").toString();
    const orders = await fetchWooOrders({ status, per_page });
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Woo request failed" });
  }
});

app.get("/dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard Commandes</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    h1 { margin: 0 0 16px; }
    .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
    label { font-size: 14px; color: #333; }
    input, select, button { padding: 8px 10px; font-size: 14px; }
    button { cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #eee; padding: 10px; text-align: left; font-size: 14px; }
    th { background: #fafafa; }
    .badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:12px; background:#eef; }
    .muted { color:#666; font-size:12px; }
    .row { overflow:auto; }
  </style>
</head>
<body>
  <h1>🧾 Commandes WooCommerce</h1>

  <div class="controls">
    <label>Token:
      <input id="token" type="password" placeholder="MCP_TOKEN" style="width:220px" />
    </label>
    <label>Status:
      <select id="status">
        <option value="processing">processing</option>
        <option value="on-hold">on-hold</option>
        <option value="pending">pending</option>
        <option value="completed">completed</option>
        <option value="cancelled">cancelled</option>
        <option value="refunded">refunded</option>
        <option value="failed">failed</option>
      </select>
    </label>
    <label>Par page:
      <input id="perpage" type="number" value="10" min="1" max="50" style="width:80px" />
    </label>
    <button id="refresh">Actualiser</button>
    <span id="info" class="muted"></span>
  </div>

  <div class="row">
    <table id="grid">
      <thead>
        <tr>
          <th>ID</th>
          <th>N°</th>
          <th>Total</th>
          <th>Date</th>
          <th>Status</th>
          <th>Client</th>
          <th>Ville</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

<script>
  const els = {
    token: document.getElementById('token'),
    status: document.getElementById('status'),
    perpage: document.getElementById('perpage'),
    refresh: document.getElementById('refresh'),
    info: document.getElementById('info'),
    body: document.querySelector('#grid tbody')
  };

  els.token.value = localStorage.getItem('mcp_token') || '';
  els.token.addEventListener('change', () => {
    localStorage.setItem('mcp_token', els.token.value || '');
  });

  async function load() {
    els.info.textContent = 'Chargement...';
    els.body.innerHTML = '';
    try {
      const qs = new URLSearchParams({
        status: els.status.value,
        per_page: els.perpage.value
      }).toString();

      const headers = { 'Accept': 'application/json' };
      const token = els.token.value.trim();
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const res = await fetch('/orders?' + qs, { headers });
      const json = await res.json();

      if (!json.ok) throw new Error(json.error || 'Erreur inconnue');

      json.orders.forEach(o => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${o.id}</td>
          <td>\${o.number}</td>
          <td>\${o.total} \${o.currency || ''}</td>
          <td>\${(o.date_created || '').replace('T',' ').replace('Z','')}</td>
          <td><span class="badge">\${o.status}</span></td>
          <td>\${o.customer || ''}</td>
          <td>\${o.city || ''}</td>
        \`;
        els.body.appendChild(tr);
      });

      els.info.textContent = \`\${json.orders.length} commandes\`;
    } catch (e) {
      els.info.textContent = 'Erreur: ' + (e.message || e);
    }
  }

  els.refresh.addEventListener('click', load);
  load();
</script>
</body>
</html>`);
});

// --------------------------------------------------------------------
// --------------------------- API COMPTA ------------------------------
// --------------------------------------------------------------------

// Ex: /accounting?year=2025&statuses=completed,processing
app.get("/accounting", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    const statuses = (req.query.statuses || "completed,processing")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    requireWoo();

    // bornes de l'année en ISO
    const afterISO  = new Date(Date.UTC(year, 0, 1, 0, 0, 0)).toISOString();
    const beforeISO = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0)).toISOString();

    // init buckets mensuels
    const months = {};
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, "0")}`;
      months[key] = {
        month: key,
        orders_count: 0,
        gross_sales: 0,   // total des commandes
        refunds_count: 0,
        refunds_total: 0, // total des remboursements
        net_revenue: 0,   // gross - refunds
      };
    }

    // 1) Ventes (CA brut) pour chaque statut choisi
    for (const status of statuses) {
      const orders = await fetchOrdersPaged({ status, afterISO, beforeISO });
      for (const o of orders) {
        const key = monthKey(o.date_created);
        const total = parseFloat(o.total || "0") || 0;
        if (months[key]) {
          months[key].orders_count += 1;
          months[key].gross_sales  += total;
        }
      }
    }

    // 2) Remboursements: parcourir toutes les commandes de l'année
    const allOrders = await fetchOrdersPaged({ status: "any", afterISO, beforeISO });
    for (const o of allOrders) {
      const refunds = await fetchRefundsForOrder(o.id);
      for (const r of refunds) {
        // r.amount positif côté API Woo ; on agrège par date du refund
        const k = monthKey(r.date_created || o.date_created);
        const amt = Math.abs(parseFloat(r.amount || "0") || 0);
        if (months[k]) {
          months[k].refunds_count += 1;
          months[k].refunds_total += amt;
        }
      }
    }

    // 3) Net
    for (const k of Object.keys(months)) {
      months[k].gross_sales   = Number(months[k].gross_sales.toFixed(2));
      months[k].refunds_total = Number(months[k].refunds_total.toFixed(2));
      months[k].net_revenue   = Number((months[k].gross_sales - months[k].refunds_total).toFixed(2));
    }

    return res.json({ ok: true, year, statuses, months: Object.values(months) });
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || "Accounting failed";
    return res.status(500).json({ ok: false, error: msg });
  }
});

// Tableau HTML pour la compta
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Comptabilité — Ventes & Remboursements</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
  h1 { margin: 0 0 16px; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
  label { font-size:14px; color:#333; }
  input, select, button { padding:8px 10px; font-size:14px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  th, td { padding:10px; border-bottom:1px solid #eee; text-align:right; }
  th:first-child, td:first-child { text-align:left; }
  th { background:#fafafa; }
  tfoot td { font-weight:bold; background:#f8f8f8; }
  .muted { color:#666; font-size:12px; margin-left:6px; }
</style>
</head>
<body>
  <h1>📊 Comptabilité — Ventes & Remboursements</h1>
  <div class="controls">
    <label>Token:
      <input id="token" type="password" placeholder="MCP_TOKEN" style="width:220px" />
    </label>
    <label>Année:
      <input id="year" type="number" min="2018" value="${new Date().getFullYear()}" style="width:90px" />
    </label>
    <label>Statuses (ventes):
      <input id="statuses" type="text" value="completed,processing" style="width:220px" />
    </label>
    <button id="refresh">Actualiser</button>
    <button id="export">Exporter CSV</button>
    <span id="info" class="muted"></span>
  </div>

  <table id="grid">
    <thead>
      <tr>
        <th>Mois</th>
        <th>Nb commandes</th>
        <th>Ventes (brut)</th>
        <th>Remboursements</th>
        <th>Net</th>
      </tr>
    </thead>
    <tbody></tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td id="t_orders"></td>
        <td id="t_gross"></td>
        <td id="t_refunds"></td>
        <td id="t_net"></td>
      </tr>
    </tfoot>
  </table>

<script>
const els = {
  token: document.getElementById('token'),
  year: document.getElementById('year'),
  statuses: document.getElementById('statuses'),
  refresh: document.getElementById('refresh'),
  exportBtn: document.getElementById('export'),
  info: document.getElementById('info'),
  body: document.querySelector('#grid tbody'),
  totals: {
    orders: document.getElementById('t_orders'),
    gross: document.getElementById('t_gross'),
    refunds: document.getElementById('t_refunds'),
    net: document.getElementById('t_net'),
  }
};
els.token.value = localStorage.getItem('mcp_token') || '';
els.token.addEventListener('change', () => localStorage.setItem('mcp_token', els.token.value || ''));

let last = [];

function euro(n){ return Number(n||0).toFixed(2) + " €"; }

function render(rows){
  els.body.innerHTML = '';
  let sOrders=0, sGross=0, sRefunds=0, sNet=0;
  rows.forEach(r=>{
    sOrders += r.orders_count;
    sGross  += r.gross_sales;
    sRefunds+= r.refunds_total;
    sNet    += r.net_revenue;
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${r.month}</td>
      <td>\${r.orders_count}</td>
      <td>\${euro(r.gross_sales)}</td>
      <td>\${euro(r.refunds_total)}</td>
      <td>\${euro(r.net_revenue)}</td>
    \`;
    els.body.appendChild(tr);
  });
  els.totals.orders.textContent  = sOrders;
  els.totals.gross.textContent   = euro(sGross);
  els.totals.refunds.textContent = euro(sRefunds);
  els.totals.net.textContent     = euro(sNet);
}

async function load(){
  els.info.textContent = 'Calcul en cours...';
  render([]);
  try{
    const qs = new URLSearchParams({
      year: els.year.value.trim(),
      statuses: els.statuses.value.trim()
    }).toString();
    const headers = { 'Accept':'application/json' };
    const token = els.token.value.trim();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch('/accounting?' + qs, { headers });
    const json = await res.json();
    if(!json.ok) throw new Error(json.error || 'Erreur');
    last = json.months;
    render(last);
    els.info.textContent = 'OK';
  }catch(e){
    els.info.textContent = 'Erreur: ' + (e.message || e);
  }
}

function toCSV(rows){
  const header = ["month","orders_count","gross_sales","refunds_total","net_revenue"];
  const escape = v => "\\""+String(v??"").replace(/"/g,'""')+"\\"";
  const lines=[header.join(",")].concat(rows.map(r=>header.map(k=>escape(r[k])).join(",")));
  return lines.join("\\n");
}

els.refresh.addEventListener('click', load);
els.exportBtn.addEventListener('click', ()=>{
  if(!last.length){ alert('Rien à exporter'); return; }
  const csv = toCSV(last);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download = 'accounting-'+els.year.value+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

load();
</script>
</body>
</html>`);
});

// --------------------------------------------------------------------
// ----------------------------- MCP ----------------------------------
// --------------------------------------------------------------------

app.post("/mcp", async (req, res) => {
  const { method, params } = req.body || {};

  if (method === "tools.list") {
    return res.json({
      type: "tool_result",
      content: {
        tools: [
          {
            name: "getOrders",
            description: "Liste les commandes WooCommerce (status=processing par défaut).",
            input_schema: {
              type: "object",
              properties: {
                status:   { type: "string", default: "processing" },
                per_page: { type: "number", default: 10 }
              }
            }
          }
        ]
      }
    });
  }

  if (method === "tools.call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "getOrders") {
      try {
        const orders = await fetchWooOrders({
          status: args.status || "processing",
          per_page: args.per_page || 10
        });
        return res.json({ type: "tool_result", content: orders });
      } catch (e) {
        const msg =
          e?.response?.data?.message ||
          e?.response?.statusText ||
          e?.message || "Woo request failed";
        return res.json({ type: "tool_error", error: msg });
      }
    }

    return res.json({ type: "tool_error", error: `Unknown tool: ${name}` });
  }

  return res.json({ type: "tool_error", error: "Unknown method" });
});

// --------------------------------------------------------------------
// ------------------------- START SERVER -----------------------------
// --------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🔹 MCP server running on port ${PORT}`);
});
