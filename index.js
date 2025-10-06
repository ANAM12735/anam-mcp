// index.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- WooCommerce config via env ---
const WC_URL    = process.env.WC_URL || "";     // ex: https://anam-and-styles.com/wp-json/wc/v3/
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
// On laisse passer la page /dashboard et / (la page chargera les données via fetch avec token)
app.use((req, res, next) => {
  const token = process.env.MCP_TOKEN || "";
  if (!token) return next(); // pas de token => aucune auth requise
  const openPaths = new Set(["/", "/dashboard", "/debug-auth"]);
  if (openPaths.has(req.path)) return next();
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// --- Utilitaire: récupérer des commandes WooCommerce -----------------
async function fetchWooOrders({ status = "processing", per_page = 10 }) {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set");
  }
  const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${Math.min(Math.max(parseInt(per_page, 10) || 10, 1), 50)}`;
  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000
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

// --- API simple pour le dashboard (JSON) -----------------------------
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

// --- Page Dashboard (HTML + JS) --------------------------------------
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

  // Persiste le token localement (navigateur)
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
      // Si ton serveur a un MCP_TOKEN défini, on l'envoie
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
  // Auto-load au premier affichage
  load();
</script>
</body>
</html>`);
});

// --- MCP endpoint (pour ChatGPT/clients MCP) -------------------------
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

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🔹 MCP server running on port ${PORT}`);
});
