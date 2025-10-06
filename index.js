// index.js — serveur MCP + mini tableaux de bord (orders + accounting)
// Dépendances: express, axios (npm i express axios)
// "type": "module" conseillé dans package.json

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- WooCommerce credentials via env ---
const WC_URL    = process.env.WC_URL    || ""; // ex: https://example.com/wp-json/wc/v3/
const WC_KEY    = process.env.WC_KEY    || ""; // ck_...
const WC_SECRET = process.env.WC_SECRET || ""; // cs_...

// -----------------------------------------------------------------------------
// Health check
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam & Styles", version: 1 });
});

// Debug (ne révèle pas la valeur du token)
app.get("/debug-auth", (_req, res) => {
  const isSet = !!(process.env.MCP_TOKEN && String(process.env.MCP_TOKEN).length > 0);
  res.json({ MCP_TOKEN_defined: isSet });
});

// -----------------------------------------------------------------------------
// Auth Bearer globale (si MCP_TOKEN est défini)
// On laisse passer: /, /dashboard, /accounting-dashboard, /debug-auth, /favicon.ico
app.use((req, res, next) => {
  const token = process.env.MCP_TOKEN || "";
  if (!token) return next(); // pas d'auth si pas de token
  const openPaths = new Set([
    "/",
    "/dashboard",
    "/accounting-dashboard",
    "/debug-auth",
    "/favicon.ico",
  ]);
  if (openPaths.has(req.path)) return next();

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// -----------------------------------------------------------------------------
// Utils WooCommerce

function monthKey(dateStr) {
  // "2025-10-06T04:39:44" -> "2025-10"
  return (dateStr || "").slice(0, 7);
}

function assertWooCreds() {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set");
  }
}

// Liste simple (pour le mini dashboard Orders)
async function fetchWooOrders({ status = "processing", per_page = 10 }) {
  assertWooCreds();
  const cap = Math.min(Math.max(parseInt(per_page, 10) || 10, 1), 50);
  const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${cap}`;
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
    customer:     `${o?.billing?.first_name || ""} ${o?.billing?.last_name || ""}`.trim(),
    city:         o?.shipping?.city || ""
  }));
}

// Pagination (pour la compta) avec preview pour limiter la charge
async function fetchOrdersPaged({ status, afterISO, beforeISO, preview }) {
  assertWooCreds();
  const results = [];
  const per_page = 100; // max Woo
  let page = 1;

  while (true) {
    const url =
      `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${per_page}` +
      `&page=${page}&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`;

    const { data, headers } = await axios.get(url, {
      auth: { username: WC_KEY, password: WC_SECRET },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 300
    });

    const batch = Array.isArray(data) ? data : [];
    results.push(...batch);

    // Si on a demandé un aperçu (ex: preview=10), on s'arrête vite
    if (preview && results.length >= preview) {
      return results.slice(0, preview);
    }

    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }

  return results;
}

async function fetchRefundsForOrder(orderId) {
  assertWooCreds();
  const url = `${WC_URL}orders/${orderId}/refunds`;
  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000,
  });
  return Array.isArray(data) ? data : [];
}

// -----------------------------------------------------------------------------
// API simple Orders (JSON) — utilisée par /dashboard
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

// -----------------------------------------------------------------------------
// Page Dashboard (liste des commandes)
app.get("/dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard Commandes</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; color:#111; }
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
    .row { overflow:auto; }
  </style>
</head>
<body>
  <h1>Commandes WooCommerce</h1>

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

// -----------------------------------------------------------------------------
// MCP endpoint (pour ChatGPT/clients MCP)
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

// -----------------------------------------------------------------------------
// API Accounting — agrège ventes et remboursements par mois
// Query:
//   year=2025
//   statuses=completed,processing
//   preview=10          (facultatif: limite le nombre de commandes par status)
// Retour: { ok, year, statuses, preview, months:[{month, orders_count, gross_sales, refunds_count, refunds_total, net_revenue}] }
app.get("/accounting", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    const statuses = (req.query.statuses || "completed,processing")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const preview = parseInt(req.query.preview || "0", 10) || 0; // 0 = pas de limite

    assertWooCreds();

    const afterISO = new Date(Date.UTC(year, 0, 1)).toISOString();
    const beforeISO = new Date(Date.UTC(year + 1, 0, 1)).toISOString();

    const months = {};
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, "0")}`;
      months[key] = {
        month: key,
        orders_count: 0,
        gross_sales: 0,
        refunds_count: 0,
        refunds_total: 0,
        net_revenue: 0,
      };
    }

    // Récupère des commandes par status (avec preview pour limiter la charge)
    const consideredOrders = [];
    for (const status of statuses) {
      const orders = await fetchOrdersPaged({ status, afterISO, beforeISO, preview });
      for (const o of orders) {
        const key = monthKey(o.date_created);
        const total = parseFloat(o.total || "0") || 0;
        if (months[key]) {
          months[key].orders_count++;
          months[key].gross_sales += total;
        }
        consideredOrders.push(o);
      }
    }

    // Remboursements: on ne regarde que les commandes déjà considérées
    for (const o of consideredOrders) {
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

    for (const k of Object.keys(months)) {
      const m = months[k];
      m.gross_sales   = +m.gross_sales.toFixed(2);
      m.refunds_total = +m.refunds_total.toFixed(2);
      m.net_revenue   = +(m.gross_sales - m.refunds_total).toFixed(2);
    }

    res.json({ ok: true, year, statuses, preview, months: Object.values(months) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Accounting failed" });
  }
});

// -----------------------------------------------------------------------------
// Page Accounting (tableau mois par mois + export CSV)
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Comptabilite — Ventes & Remboursements</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; color:#111; }
    h1 { margin: 0 0 16px; }
    .controls { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; align-items:center; }
    label { font-size:14px; color:#333; }
    input, select, button { padding:8px 10px; font-size:14px; }
    button { cursor:pointer; }
    table { width:100%; border-collapse: collapse; margin-top:8px; }
    th, td { border-bottom:1px solid #eee; padding:10px; text-align:left; font-size:14px; }
    th { background:#fafafa; }
    .muted { color:#666; font-size:12px; margin-left:8px; }
    tfoot td { font-weight:600; }
  </style>
</head>
<body>
  <h1>Comptabilite — Ventes & Remboursements</h1>

  <div class="controls">
    <label>Token:
      <input id="token" type="password" placeholder="MCP_TOKEN" style="width:220px" />
    </label>
    <label>Annee:
      <input id="year" type="number" min="2000" max="2100" value="${new Date().getFullYear()}" style="width:100px" />
    </label>
    <label>Status (ventes, liste separee par des virgules):
      <input id="statuses" type="text" value="completed,processing" style="width:260px" />
    </label>
    <label>Preview (limite nb cmd / status):
      <input id="preview" type="number" min="0" value="0" style="width:90px" />
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
        <th>Ventes brutes (EUR)</th>
        <th>Nb remboursements</th>
        <th>Remboursements (EUR)</th>
        <th>Net (EUR)</th>
      </tr>
    </thead>
    <tbody></tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td id="t_cmd">0</td>
        <td id="t_gross">0.00</td>
        <td id="t_rc">0</td>
        <td id="t_ref">0.00</td>
        <td id="t_net">0.00</td>
      </tr>
    </tfoot>
  </table>

<script>
  const els = {
    token: document.getElementById('token'),
    year: document.getElementById('year'),
    statuses: document.getElementById('statuses'),
    preview: document.getElementById('preview'),
    refresh: document.getElementById('refresh'),
    exportBtn: document.getElementById('export'),
    info: document.getElementById('info'),
    body: document.querySelector('#grid tbody'),
    tcmd: document.getElementById('t_cmd'),
    tgross: document.getElementById('t_gross'),
    trc: document.getElementById('t_rc'),
    tref: document.getElementById('t_ref'),
    tnet: document.getElementById('t_net'),
  };

  els.token.value = localStorage.getItem('mcp_token') || '';
  els.token.addEventListener('change', () => {
    localStorage.setItem('mcp_token', els.token.value || '');
  });

  function toCSV(rows) {
    const esc = v => ('"'+String(v).replace(/"/g,'""')+'"');
    return rows.map(r => r.map(esc).join(",")).join("\\n");
  }

  function download(name, text) {
    const blob = new Blob([text], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function load() {
    els.info.textContent = 'Chargement...';
    els.body.innerHTML = '';
    els.tcmd.textContent = '0';
    els.tgross.textContent = '0.00';
    els.trc.textContent = '0';
    els.tref.textContent = '0.00';
    els.tnet.textContent = '0.00';

    try {
      const qs = new URLSearchParams({
        year: els.year.value,
        statuses: els.statuses.value,
        preview: els.preview.value
      }).toString();

      const headers = { 'Accept': 'application/json' };
      const token = els.token.value.trim();
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const res = await fetch('/accounting?' + qs, { headers });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Erreur inconnue');

      let sumCmd = 0, sumGross = 0, sumRc = 0, sumRef = 0, sumNet = 0;

      json.months.forEach(m => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${m.month}</td>
          <td>\${m.orders_count}</td>
          <td>\${m.gross_sales.toFixed(2)}</td>
          <td>\${m.refunds_count}</td>
          <td>\${m.refunds_total.toFixed(2)}</td>
          <td>\${m.net_revenue.toFixed(2)}</td>
        \`;
        els.body.appendChild(tr);

        sumCmd += m.orders_count;
        sumGross += m.gross_sales;
        sumRc += m.refunds_count;
        sumRef += m.refunds_total;
        sumNet += m.net_revenue;
      });

      els.tcmd.textContent = String(sumCmd);
      els.tgross.textContent = sumGross.toFixed(2);
      els.trc.textContent = String(sumRc);
      els.tref.textContent = sumRef.toFixed(2);
      els.tnet.textContent = sumNet.toFixed(2);

      els.info.textContent = 'OK (year=' + json.year + ', statuses=' + json.statuses.join(',') + (json.preview? (', preview=' + json.preview) : '') + ')';
    } catch (e) {
      els.info.textContent = 'Erreur: ' + (e.message || e);
    }
  }

  els.refresh.addEventListener('click', load);

  els.exportBtn.addEventListener('click', () => {
    const rows = [["Mois","Nb commandes","Ventes brutes (EUR)","Nb remboursements","Remboursements (EUR)","Net (EUR)"]];
    document.querySelectorAll("#grid tbody tr").forEach(tr => {
      const cells = [...tr.children].map(td => td.textContent);
      rows.push(cells);
    });
    rows.push(["Total", els.tcmd.textContent, els.tgross.textContent, els.trc.textContent, els.tref.textContent, els.tnet.textContent]);
    download("accounting.csv", toCSV(rows));
  });

  load();
</script>
</body>
</html>`);
});

// -----------------------------------------------------------------------------
// Start server
app.listen(PORT, () => {
  console.log(`MCP server running on port ${PORT}`);
});
// -------- utils mapping & somme --------
function frStatus(wooStatus) {
  const map = {
    'completed': 'Terminée',
    'processing': 'En cours de traitement',
    'on-hold': 'En attente',
    'pending': 'En attente de paiement',
    'cancelled': 'Annulée',
    'refunded': 'Remboursée',
    'failed': 'Échouée'
  };
  return map[wooStatus] || wooStatus;
}

function monthFilter(dateStr, y, m) {
  if (!y) return true;
  const d = new Date(dateStr || '');
  if (isNaN(d)) return false;
  if (m) return (d.getUTCFullYear() === y && (d.getUTCMonth() + 1) === m);
  return (d.getUTCFullYear() === y);
}

function orderAmount(o, mode) {
  if (mode === 'woo') {
    // net produits (hors taxes / port), proche “Ventes nettes”
    return (o.line_items || []).reduce((s, li) => s + (parseFloat(li.total || '0') || 0), 0);
  }
  // brut commande (produits + port + taxes – remises)
  return parseFloat(o.total || '0') || 0;
}

// -------- export plat JSON --------
app.get('/orders-flat', async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);
    const month = req.query.month ? parseInt(req.query.month, 10) : null;
    const statuses = (req.query.statuses || 'completed,processing')
      .split(',').map(s => s.trim()).filter(Boolean);
    const limit = parseInt(req.query.limit || '0', 10); // 0 = illimité
    const includeRefunds = String(req.query.include_refunds || 'false') === 'true';
    const mode = (req.query.mode || 'woo'); // 'woo' | 'gross'

    const afterISO  = new Date(Date.UTC(year, month ? month - 1 : 0, 1)).toISOString();
    const beforeISO = new Date(Date.UTC(year, month ? month : 12, 1)).toISOString();

    let rows = [];

    // commandes
    for (const status of statuses) {
      const orders = await fetchOrdersPaged({ status, afterISO, beforeISO });
      for (const o of orders) {
        const date = o.date_paid || o.date_created;
        if (!monthFilter(date, year, month)) continue;

        rows.push({
          date: (date || '').replace('T',' ').replace('Z',''),
          reference: o.number,
          client: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim(),
          nature: frStatus(o.status),
          paiement: o.payment_method_title || o.payment_method || '',
          montant_eur: +orderAmount(o, mode).toFixed(2)
        });

        if (limit > 0 && rows.length >= limit) break;
      }
      if (limit > 0 && rows.length >= limit) break;
    }

    // (optionnel) remboursements à intégrer comme lignes négatives
    if (includeRefunds) {
      // prends toutes les commandes de la période pour leurs refunds
      const all = await fetchOrdersPaged({ status: 'any', afterISO, beforeISO });
      for (const o of all) {
        const refunds = await fetchRefundsForOrder(o.id);
        for (const r of refunds) {
          const date = r.date_created || o.date_created;
          if (!monthFilter(date, year, month)) continue;
          const amt = -(Math.abs(parseFloat(r.amount || '0')) || 0); // négatif

          rows.push({
            date: (date || '').replace('T',' ').replace('Z',''),
            reference: `R-${o.number}`,
            client: `${o.billing?.first_name || ''} ${o.billing?.last_name || ''}`.trim(),
            nature: 'Remboursée',
            paiement: o.payment_method_title || o.payment_method || '',
            montant_eur: +amt.toFixed(2)
          });

          if (limit > 0 && rows.length >= limit) break;
        }
        if (limit > 0 && rows.length >= limit) break;
      }
    }

    // tri par date
    rows.sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'orders-flat failed' });
  }
});

// -------- export CSV (Excel-ready) --------
app.get('/orders-csv', async (req, res) => {
  try {
    // on réutilise /orders-flat côté serveur
    req.url = req.url.replace('/orders-csv', '/orders-flat');
    const resp = await axios.get(`${req.protocol}://${req.get('host')}${req.url}`);
    const rows = resp.data?.rows || [];

    const header = [
      'Date', 'Référence', 'Nom du client', 'Nature', 'Paiement', 'Montant encaissé (EUR)'
    ];
    const csv = [
      header.join(';'),
      ...rows.map(r =>
        [
          r.date,
          r.reference,
          r.client.replaceAll(';', ','),
          r.nature,
          (r.paiement || '').replaceAll(';', ','),
          r.montant_eur.toFixed(2).replace('.', ',')
        ].join(';')
      )
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'orders-csv failed' });
  }
});
