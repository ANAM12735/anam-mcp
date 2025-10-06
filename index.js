// index.js — serveur MCP + dashboard complet
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- WooCommerce credentials ---
const WC_URL = process.env.WC_URL || "";
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";

// -----------------------------------------------------------------------------
// Auth Bearer globale
app.use((req, res, next) => {
  const token = process.env.MCP_TOKEN || "";
  if (!token) return next();
  
  const openPaths = new Set([
    "/", "/dashboard", "/accounting-dashboard", "/debug-auth", "/favicon.ico"
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
function assertWooCreds() {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set");
  }
}

// Récupération paginée des commandes
async function fetchOrdersPaged({ status, afterISO, beforeISO, per_page = 100 }) {
  assertWooCreds();
  const results = [];
  let page = 1;

  while (true) {
    const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${per_page}&page=${page}&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`;

    const { data, headers } = await axios.get(url, {
      auth: { username: WC_KEY, password: WC_SECRET },
      timeout: 20000,
    });

    const batch = Array.isArray(data) ? data : [];
    results.push(...batch);

    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages || batch.length === 0) break;
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
// EXCEL EXPORT - Le cœur de ce que tu veux
function natureFromStatus(status) {
  switch ((status || "").toLowerCase()) {
    case "completed": return "Terminée";
    case "processing": return "En cours";
    case "refunded": return "Remboursée";
    case "cancelled": return "Annulée";
    case "failed": return "Échouée";
    case "on-hold": return "En attente";
    case "pending": return "En attente";
    default: return status || "";
  }
}

function toDateTimeLocal(iso) {
  return (iso || "").replace("T", " ").replace("Z", "").substring(0, 19);
}

async function getExcelData({ year, month, statuses, includeRefunds = true }) {
  // Calcul des dates
  let afterISO, beforeISO;
  if (year && month) {
    afterISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    beforeISO = new Date(Date.UTC(year, month, 1)).toISOString();
  } else if (year) {
    afterISO = new Date(Date.UTC(year, 0, 1)).toISOString();
    beforeISO = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
  } else {
    const now = new Date();
    beforeISO = now.toISOString();
    afterISO = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  }

  // Récupération des commandes
  const rows = [];
  for (const status of statuses) {
    const orders = await fetchOrdersPaged({ status, afterISO, beforeISO });
    
    for (const order of orders) {
      const montant = parseFloat(order.total) || 0;
      
      // Ligne de la commande
      rows.push({
        date: toDateTimeLocal(order.date_created),
        reference: order.number || order.id,
        client: `${order.billing?.first_name || ""} ${order.billing?.last_name || ""}`.trim(),
        nature: natureFromStatus(order.status),
        paiement: order.payment_method_title || "",
        montant: montant
      });

      // Lignes de remboursements si demandé
      if (includeRefunds) {
        const refunds = await fetchRefundsForOrder(order.id);
        for (const refund of refunds) {
          const montantRemise = -(parseFloat(refund.amount) || 0); // Négatif
          rows.push({
            date: toDateTimeLocal(refund.date_created || order.date_created),
            reference: order.number || order.id,
            client: `${order.billing?.first_name || ""} ${order.billing?.last_name || ""}`.trim(),
            nature: "Remboursée",
            paiement: order.payment_method_title || "",
            montant: montantRemise
          });
        }
      }
    }
  }

  // Tri par date
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// -----------------------------------------------------------------------------
// ENDPOINTS PRINCIPAUX

// Health check
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam & Styles", version: 1 });
});

// Export Excel (JSON)
app.get("/orders-excel", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) : undefined;
    const statuses = (req.query.statuses || "completed,processing").split(",").map(s => s.trim());
    const includeRefunds = String(req.query.include_refunds || "true") === "true";

    const rows = await getExcelData({ year, month, statuses, includeRefunds });

    res.json({
      ok: true,
      info: `Export ${year}${month ? `-${month}` : ''} (${statuses.join(',')})`,
      count: rows.length,
      rows
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Export Excel (CSV)
app.get("/orders-excel-csv", async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) : undefined;
    const statuses = (req.query.statuses || "completed,processing").split(",").map(s => s.trim());
    const includeRefunds = String(req.query.include_refunds || "true") === "true";

    const rows = await getExcelData({ year, month, statuses, includeRefunds });

    // Génération CSV
    const header = ["Date", "Référence", "Nom du client", "Nature", "Paiement", "Montant"];
    const csvRows = [header.join(";")];
    
    for (const row of rows) {
      const csvRow = [
        row.date,
        row.reference,
        `"${row.client.replace(/"/g, '""')}"`,
        row.nature,
        `"${row.paiement.replace(/"/g, '""')}"`,
        row.montant.toFixed(2).replace(".", ",")
      ];
      csvRows.push(csvRow.join(";"));
    }

    const csv = csvRows.join("\r\n");
    const filename = `commandes_${year}${month ? `-${month}` : ''}_${new Date().getTime()}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------------
// DASHBOARD SIMPLE
app.get("/dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <title>Export Excel Commandes</title>
  <meta charset="utf-8">
  <style>
    body { font-family: system-ui; margin: 40px; background: #f5f5f5; }
    .container { max-width: 800px; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 5px; font-weight: 600; color: #555; }
    input, select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 16px; }
    .btn { background: #007cba; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin-right: 10px; }
    .btn:hover { background: #005a87; }
    .btn-csv { background: #28a745; }
    .btn-csv:hover { background: #1e7e34; }
    .info { background: #e7f3ff; padding: 15px; border-radius: 5px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Export Excel des Commandes</h1>
    
    <form id="exportForm">
      <div class="form-group">
        <label>Année:</label>
        <input type="number" id="year" value="2025" min="2020" max="2030" required>
      </div>
      
      <div class="form-group">
        <label>Mois (optionnel):</label>
        <input type="number" id="month" min="1" max="12" placeholder="Ex: 10 pour octobre">
      </div>
      
      <div class="form-group">
        <label>Statuts des commandes:</label>
        <input type="text" id="statuses" value="completed,processing" placeholder="completed,processing,refunded">
        <small>Séparés par des virgules</small>
      </div>
      
      <div class="form-group">
        <label>
          <input type="checkbox" id="includeRefunds" checked>
          Inclure les remboursements
        </label>
      </div>
      
      <button type="button" class="btn" onclick="exportJSON()">📋 Voir les données (JSON)</button>
      <button type="button" class="btn btn-csv" onclick="exportCSV()">📥 Télécharger CSV</button>
    </form>
    
    <div id="info" class="info" style="display:none"></div>
  </div>

  <script>
    function getToken() {
      return prompt("Token d'authentification:") || "";
    }

    function buildURL(base, params) {
      const url = new URL(base, window.location.origin);
      Object.keys(params).forEach(key => {
        if (params[key] !== undefined && params[key] !== "") {
          url.searchParams.set(key, params[key]);
        }
      });
      return url.toString();
    }

    async function exportJSON() {
      const params = {
        year: document.getElementById('year').value,
        month: document.getElementById('month').value || undefined,
        statuses: document.getElementById('statuses').value,
        include_refunds: document.getElementById('includeRefunds').checked
      };

      const url = buildURL('/orders-excel', params);
      
      try {
        const token = getToken();
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        document.getElementById('info').style.display = 'block';
        document.getElementById('info').innerHTML = `
          <strong>✅ Données récupérées :</strong><br>
          ${data.count} lignes trouvées<br>
          <pre>${JSON.stringify(data.rows.slice(0, 5), null, 2)}</pre>
          ${data.count > 5 ? `<em>... et ${data.count - 5} lignes supplémentaires</em>` : ''}
        `;
      } catch (error) {
        alert('Erreur: ' + error.message);
      }
    }

    function exportCSV() {
      const params = {
        year: document.getElementById('year').value,
        month: document.getElementById('month').value || undefined,
        statuses: document.getElementById('statuses').value,
        include_refunds: document.getElementById('includeRefunds').checked
      };

      const url = buildURL('/orders-excel-csv', params);
      const token = getToken();
      
      // Téléchargement direct
      const downloadUrl = url + (token ? `&token=${encodeURIComponent(token)}` : '');
      window.open(downloadUrl, '_blank');
    }
  </script>
</body>
</html>`);
});

// -----------------------------------------------------------------------------
// Start server
app.listen(PORT, () => {
  console.log(`✅ Serveur MCP démarré sur le port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`📋 Excel JSON: http://localhost:${PORT}/orders-excel?year=2025&statuses=completed,processing`);
  console.log(`📥 Excel CSV: http://localhost:${PORT}/orders-excel-csv?year=2025&statuses=completed,processing`);
});
