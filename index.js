// index.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---- WooCommerce config via env ------------------------------------------------
const WC_URL    = process.env.WC_URL    || ""; // ex: https://anam-and-styles.com/wp-json/wc/v3/
const WC_KEY    = process.env.WC_KEY    || ""; // ck_...
const WC_SECRET = process.env.WC_SECRET || ""; // cs_...

// ---- Health check --------------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam & Styles", version: 1 });
});

// ---- Debug (ne révèle pas la valeur du token) ---------------------------------
app.get("/debug-auth", (_req, res) => {
  const isSet = !!(process.env.MCP_TOKEN && String(process.env.MCP_TOKEN).length > 0);
  res.json({ MCP_TOKEN_defined: isSet });
});

// ---- Auth Bearer globale (si MCP_TOKEN défini) --------------------------------
// On laisse passer /, /dashboard, /accounting-dashboard et /debug-auth (pages HTML)
app.use((req, res, next) => {
  const token = process.env.MCP_TOKEN || "";
  if (!token) return next(); // pas de token => pas d'auth requise

  const openPaths = new Set(["/", "/dashboard", "/accounting-dashboard", "/debug-auth"]);
  if (openPaths.has(req.path)) return next();

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ---- Util: récupérer des commandes WooCommerce --------------------------------
async function fetchWooOrders({ status = "processing", per_page = 10 }) {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set");
  }
  const safePerPage = Math.min(Math.max(parseInt(per_page, 10) || 10, 1), 50);
  const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${safePerPage}`;

  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 300
  });

  const orders = (Array.isArray(data) ? data : []).map(o => ({
    id:           o.id,
    number:       o.number,
    total:        o.total,
    currency:     o.currency,
    date_created: o.date_created,
    status:       o.status,
    customer:     `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
    city:         o.shipping?.city || ""
  }));
  return orders;
}

// ---- API JSON pour le dashboard commandes -------------------------------------
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

// ---- Page Dashboard (commandes) ------------------------------------------------
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
  .controls { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; align-items:center; }
  label { font-size:14px; color:#333; }
  input, select, button { padding:8px 10px; font-size:14px; }
  button { cursor:pointer; }
  table { width:100%; border-collapse: collapse; margin-top:8px; }
  th, td { border-bottom:1px solid #eee; padding:10px; text-align:left; font-size:14px; }
  th { background:#fafafa; }
  .badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:12px; background:#eef; }
  .muted { color:#666; font-size:12px; }
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

  <table id="grid">
    <thead>
      <tr><th>ID</th><th>N°</th><th>Total</th><th>Date</th><th>Status</th><th>Client</th><th>Ville</th></tr>
    </thead>
    <tbody></tbody>
  </table>

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
els.token.addEventListener('change', () => localStorage.setItem('mcp_token', els.token.value || ''));

async function load() {
  els.info.textContent = 'Chargement...';
  els.body.innerHTML = '';
  try {
    const qs = new URLSearchParams({ status: els.status.value, per_page: els.perpage.value }).toString();
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
        <td>\${o.city || ''}</td>\`;
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
</body></html>`);
});

// ---- MCP endpoint (pour ChatGPT/clients MCP) ----------------------------------
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
                status:   { type: "string",  default: "processing" },
                per_page: { type: "number",  default: 10 }
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
        const msg = e?.response?.data?.message || e?.response?.statusText || e?.message || "Woo request failed";
        return res.json({ type: "tool_error", error: msg });
      }
    }
    return res.json({ type: "tool_error", error: `Unknown tool: ${name}` });
  }

  return res.json({ type: "tool_error", error: "Unknown method" });
});

// ======================== COMPTABILITÉ ================================

// Util
function monthKey(dateStr) {
  // "2025-10-06T04:39:44" -> "2025-10"
  return (dateStr || "").slice(0, 7);
}

// Pagination générique côté Woo (after/before ISO 8601)
async function fetchOrdersPaged({ status, afterISO, beforeISO }) {
  const results = [];
  const per_page = 100; // max Woo
  let page = 1;

  while (true) {
    const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${per_page}&page=${page}&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`;
    const { data, headers } = await axios.get(url, {
      auth: { username: WC_KEY, password: WC_SECRET },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 300
    });
    results.push(...(Array.isArray(data) ? data : []));
    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

// Récupérer tous les refunds d'une commande
async function fetchRefundsForOrder(orderId) {
  const url = `${WC_URL}orders/${orderId}/refunds`;
  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 300
  });
  return Array.isArray(data) ? data : [];
}

// ---- API Comptabilité JSON ------------------------------------------
app.get("/accounting", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    const statuses = (req.query.statuses || "completed,processing")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (!WC_URL || !WC_KEY || !WC_SECRET) {
      return res.status(500).json({ ok: false, error: "WooCommerce credentials not set" });
    }

    const afterISO  = new Date(Date.UTC(year,     0, 1)).toISOString();
    const beforeISO = new Date(Date.UTC(year + 1, 0, 1)).toISOString();

    // Init mois
    const months = {};
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, "0")}`;
      months[key] = {
        month: key,
        orders_count: 0,
        gross_sales: 0,
        refunds_count: 0,
        refunds_total: 0,
        net_revenue: 0
      };
    }

    // Ventes brutes par status choisi
    for (const status of statuses) {
      const orders = await fetchOrdersPaged({ status, afterISO, beforeISO });
      for (const o of orders) {
        const key = monthKey(o.date_created);
        const total = parseFloat(o.total || "0") || 0;
        if (months[key]) {
          months[key].orders_count++;
          months[key].gross_sales += total;
        }
      }
    }

    // Remboursements (tous statuts)
    const allOrders = await fetchOrdersPaged({ status: "any", afterISO, beforeISO });
    for (const o of allOrders) {
      const refunds = await fetchRefundsForOrder(o.id);
      for (const r of refunds) {
        const key = monthKey(r.date_created || o.date_created);
        const amt = Math.abs(parseFloat(r.amount || "0")) || 0;
        if (months[key]) {
          months[key].refunds_count++;
          months[key].refunds_total += amt;
        }
      }
    }

    // Net
    for (const k of Object.keys(months)) {
      const m = months[k];
      m.gross_sales   = +m.gross_sales.toFixed(2);
      m.refunds_total = +m.refunds_total.toFixed(2);
      m.net_revenue   = +(m.gross_sales - m.refunds_total).toFixed(2);
    }

    res.json({ ok: true, year, statuses, months: Object.values(months) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Accounting failed" });
  }
});

// ---- Mini Dashboard Comptabilité (HTML) ---------------------------------------
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
  .controls { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; align-items:center; }
  label { font-size:14px; color:#333; }
  input, select, button { padding:8px 10px; font-size:14px; }
  table { width:100%; border-collapse: collapse; margin-top:8px; }
  th, td { border-bottom:1px solid #eee; padding:10px; text-align:left; font-size:14px; }
  th { background:#fafafa; }
  .muted { color:#666; font-size:12px; }
  .right { text-align:right; }
  .pill { display:inline-block; padding:2px 8px; border-radius:12px; font-size:12px; background:#eef; }
</style>
</head>
<body>
  <h1>📊 Comptabilité — Ventes & Remboursements</h1>

  <div class="controls">
    <label>Token:
      <input id="token" type="password" placeholder="MCP_TOKEN" style="width:220px" />
    </label>
    <label>Année:
      <input id="year" type="number" min="2000" max="2100" style="width:100px" />
    </label>
    <label>Statuts (ventes):
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
        <th class="right">Nb commandes</th>
        <th class="right">Ventes brutes (EUR)</th>
        <th class="right">Nb remboursements</th>
        <th class="right">Remboursements (EUR)</th>
        <th class="right">Net (EUR)</th>
      </tr>
    </thead>
    <tbody></tbody>
    <tfoot>
      <tr>
        <th>Total</th>
        <th class="right" id="t_orders">0</th>
        <th class="right" id="t_gross">0.00</th>
        <th class="right" id="t_refcnt">0</th>
        <th class="right" id="t_refund">0.00</th>
        <th class="right" id="t_net">0.00</th>
      </tr>
    </tfoot>
  </table>

<script>
const els = {
  token: document.getElementById('token'),
  year: document.getElementById('year'),
  statuses: document.getElementById('statuses'),
  refresh: document.getElementById('refresh'),
  export: document.getElementById('export'),
  info: document.getElementById('info'),
  body: document.querySelector('#grid tbody'),
  t_orders: document.getElementById('t_orders'),
  t_gross: document.getElementById('t_gross'),
  t_refcnt: document.getElementById('t_refcnt'),
  t_refund: document.getElementById('t_refund'),
  t_net: document.getElementById('t_net')
};
els.token.value = localStorage.getItem('mcp_token') || '';
els.token.addEventListener('change', () => localStorage.setItem('mcp_token', els.token.value || ''));
els.year.value = new Date().getFullYear();

let lastData = null;

function toCSV(rows) {
  const esc = v => ('"'+String(v).replaceAll('"','""')+'"');
  return rows.map(r => r.map(esc).join(',')).join('\\n');
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type:'text/csv;charset=utf-8;' }));
  a.download = filename;
  a.click();
}

async function load() {
  els.info.textContent = 'Chargement...';
  els.body.innerHTML = '';
  try {
    const qs = new URLSearchParams({
      year: els.year.value,
      statuses: els.statuses.value
    }).toString();
    const headers = { 'Accept': 'application/json' };
    const token = els.token.value.trim();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch('/accounting?' + qs, { headers });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur inconnue');

    lastData = json;
    let totOrders = 0, totGross = 0, totRefCnt = 0, totRefund = 0, totNet = 0;

    json.months.forEach(m => {
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td>\${m.month}</td>
        <td class="right">\${m.orders_count}</td>
        <td class="right">\${m.gross_sales.toFixed(2)}</td>
        <td class="right">\${m.refunds_count}</td>
        <td class="right">\${m.refunds_total.toFixed(2)}</td>
        <td class="right"><span class="pill">\${m.net_revenue.toFixed(2)}</span></td>\`;
      els.body.appendChild(tr);

      totOrders += m.orders_count;
      totGross  += m.gross_sales;
      totRefCnt += m.refunds_count;
      totRefund += m.refunds_total;
      totNet    += m.net_revenue;
    });

    els.t_orders.textContent = totOrders;
    els.t_gross.textContent  = totGross.toFixed(2);
    els.t_refcnt.textContent = totRefCnt;
    els.t_refund.textContent = totRefund.toFixed(2);
    els.t_net.textContent    = totNet.toFixed(2);

    els.info.textContent = 'OK';
  } catch (e) {
    els.info.textContent = 'Erreur: ' + (e.message || e);
  }
}

els.refresh.addEventListener('click', load);
els.export.addEventListener('click', () => {
  if (!lastData?.months) return;
  const rows = [
    ['Mois','Nb commandes','Ventes brutes (EUR)','Nb remboursements','Remboursements (EUR)','Net (EUR)']
  ];
  let totOrders=0, totGross=0, totRefCnt=0, totRefund=0, totNet=0;
  lastData.months.forEach(m => {
    rows.push([m.month, m.orders_count, m.gross_sales, m.refunds_count, m.refunds_total, m.net_revenue]);
    totOrders+=m.orders_count; totGross+=m.gross_sales; totRefCnt+=m.refunds_count; totRefund+=m.refunds_total; totNet+=m.net_revenue;
  });
  rows.push(['TOTAL', totOrders, totGross.toFixed(2), totRefCnt, totRefund.toFixed(2), totNet.toFixed(2)]);
  const csv = toCSV(rows);
  download(\`compta-\${(lastData.year||'')}.csv\`, csv);
});

load();
</script>
</body></html>`);
});

// ---- Start server --------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🔹 MCP server running on port ${PORT}`);
});
