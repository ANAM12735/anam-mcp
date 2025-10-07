import express from "express";
import fetch from "node-fetch";
import https from "https";

const app = express();
const PORT = process.env.PORT || 10000;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: 30000,
  minVersion: 'TLSv1.2'
});

app.use(express.json());

// ======================= HEALTH & DEBUG =======================
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "MCP Anam", 
    version: "7.0",
    status: "🚀 Complètement opérationnel avec export Excel"
  });
});

app.get("/debug-auth", (_req, res) => {
  res.json({
    MCP_TOKEN_defined: !!MCP_TOKEN,
    WC_URL_set: !!WC_URL,
    WC_KEY_set: !!WC_KEY,
    WC_SECRET_set: !!WC_SECRET,
    WC_URL_value: WC_URL
  });
});

// ======================= WOOCOMMERCE UTILS =======================
async function wooGetJSON(pathWithQuery, options = {}) {
  const { attempts = 2, timeout = 20000 } = options;
  
  const url = `${WC_URL}/${pathWithQuery.replace(/^\/+/, "")}`;
  const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
          "User-Agent": "MCP-Anam/1.0",
          "Content-Type": "application/json"
        },
        agent: httpsAgent,
        timeout: timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`WooCommerce ${response.status}: ${errorText}`);
      }

      return await response.json();

    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function wooGetRefunds(orderId) {
  return wooGetJSON(`orders/${orderId}/refunds`, { attempts: 1 });
}

function monthRange(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10) - 1;
  const afterISO = new Date(Date.UTC(y, m, 1, 0, 0, 0)).toISOString();
  const beforeISO = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString();
  return { afterISO, beforeISO };
}

// ======================= MCP ENDPOINT =======================
function mcpAuth(req, res, next) {
  if (!MCP_TOKEN) return res.status(500).json({ error: "MCP_TOKEN non défini" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Bearer token requis" });
  if (auth.slice(7) !== MCP_TOKEN) return res.status(403).json({ error: "Token invalide" });
  next();
}

app.post("/mcp", mcpAuth, async (req, res) => {
  try {
    const { method, params } = req.body || {};

    if (method === "tools.list") {
      return res.json({
        type: "tool_result",
        content: {
          tools: [{
            name: "getOrders",
            description: "Liste les commandes WooCommerce (status et per_page).",
            input_schema: {
              type: "object",
              properties: {
                status: { type: "string", default: "processing" },
                per_page: { type: "number", default: 5 }
              },
              required: ["status"]
            }
          }]
        }
      });
    }

    if (method === "tools.call") {
      const name = params?.name;
      const args = params?.arguments || {};

      if (name === "getOrders") {
        const status = String(args.status || "processing");
        const per_page = Math.min(Math.max(parseInt(args.per_page || 5, 10), 1), 50);

        const data = await wooGetJSON(`orders?status=${encodeURIComponent(status)}&per_page=${per_page}`);

        const orders = (Array.isArray(data) ? data : []).map(o => ({
          id: o.id,
          number: o.number,
          total: o.total,
          currency: o.currency,
          date_created: o.date_created,
          status: o.status,
          customer: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
          city: o.shipping?.city || o.billing?.city || ""
        }));

        return res.json({ type: "tool_result", content: orders });
      }
      return res.json({ type: "tool_error", error: `Unknown tool: ${name}` });
    }

    return res.json({ type: "tool_error", error: "Unknown method" });
  } catch (err) {
    console.error("MCP ERROR:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ======================= ORDERS-FLAT AVEC EXPORT EXCEL =======================
app.get("/orders-flat", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);
    const month = parseInt(req.query.month || (new Date().getUTCMonth() + 1), 10);
    const statuses = String(req.query.statuses || "completed,processing")
      .split(",").map(s => s.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 1000));
    const includeRefunds = String(req.query.include_refunds || "true").toLowerCase() === "true";
    const format = String(req.query.format || "json").toLowerCase();

    const { afterISO, beforeISO } = monthRange(year, month);
    const rows = [];

    for (const status of statuses) {
      let page = 1;
      let hasMore = true;

      while (hasMore && rows.length < limit) {
        const per_page = Math.min(100, limit - rows.length);
        const query = `orders?status=${status}&per_page=${per_page}&page=${page}&after=${afterISO}&before=${beforeISO}`;
        
        const data = await wooGetJSON(query);
        
        if (!Array.isArray(data) || data.length === 0) {
          hasMore = false;
          break;
        }

        for (const order of data) {
          const total = parseFloat(order.total || "0") || 0;
          const shipping = parseFloat(order.shipping_total || "0") || 0;
          const discount = Math.abs(parseFloat(order.discount_total || "0") || 0);
          const montantReel = total + shipping - discount;

          rows.push({
            date: (order.date_created || "").replace("T", " ").replace("Z", ""),
            reference: order.number,
            nom: (order.billing?.last_name || "").toString().trim(),
            prenom: (order.billing?.first_name || "").toString().trim(),
            nature: "Payé",
            moyen_paiement: order.payment_method_title || order.payment_method || "",
            montant: montantReel,
            frais_port: shipping,
            remise: discount,
            currency: order.currency || "EUR",
            status: order.status,
            ville: order.billing?.city || order.shipping?.city || ""
          });

          if (includeRefunds) {
            try {
              const refunds = await wooGetRefunds(order.id);
              if (Array.isArray(refunds)) {
                for (const refund of refunds) {
                  const refundAmount = -Math.abs(parseFloat(refund.amount || "0") || 0);
                  rows.push({
                    date: (refund.date_created || order.date_created || "").replace("T", " ").replace("Z", ""),
                    reference: `${order.number}-R${refund.id}`,
                    nom: (order.billing?.last_name || "").toString().trim(),
                    prenom: (order.billing?.first_name || "").toString().trim(),
                    nature: "Remboursé",
                    moyen_paiement: order.payment_method_title || order.payment_method || "",
                    montant: refundAmount,
                    frais_port: 0,
                    remise: 0,
                    currency: order.currency || "EUR",
                    status: "refunded",
                    ville: order.billing?.city || order.shipping?.city || ""
                  });
                }
              }
            } catch (refundError) {
              console.log("⚠️ Remboursements ignorés pour", order.number);
            }
          }

          if (rows.length >= limit) break;
        }

        if (data.length < per_page) hasMore = false;
        page++;
        
        if (hasMore && rows.length < limit) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      if (rows.length >= limit) break;
    }

    // ======================= EXPORT EXCEL RÉEL =======================
    if (format === "excel" || format === "csv") {
      const headers = [
        "Date", "Référence", "Nom", "Prénom", "Nature", 
        "Moyen de paiement", "Montant (€)", "Frais de port (€)", 
        "Remise (€)", "Devise", "Statut", "Ville"
      ];
      
      const csvRows = rows.map(row => [
        `"${row.date}"`,
        `"${row.reference}"`,
        `"${row.nom}"`,
        `"${row.prenom}"`,
        `"${row.nature}"`,
        `"${row.moyen_paiement}"`,
        row.montant.toFixed(2).replace('.', ','),
        row.frais_port.toFixed(2).replace('.', ','),
        row.remise.toFixed(2).replace('.', ','),
        `"${row.currency}"`,
        `"${row.status}"`,
        `"${row.ville}"`
      ]);
      
      const csvContent = [
        headers.join(";"),
        ...csvRows.map(row => row.join(";"))
      ].join("\n");
      
      const filename = `commandes_${year}-${String(month).padStart(2, '0')}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csvContent);
    }

    // ======================= RÉPONSE JSON =======================
    res.json({
      ok: true,
      year,
      month,
      statuses,
      include_refunds: includeRefunds,
      count: rows.length,
      rows
    });

  } catch (error) {
    console.error("orders-flat ERROR:", error);
    res.status(500).json({ 
      ok: false, 
      error: error.message
    });
  }
});

// ======================= DASHBOARD AVEC EXPORT CORRIGÉ =======================
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>Comptabilité — MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { 
    font-family: system-ui, -apple-system, sans-serif; 
    background: #f8fafc; 
    color: #334155;
    line-height: 1.6;
    padding: 20px;
  }
  
  .container {
    max-width: 1200px;
    margin: 0 auto;
    background: white;
    border-radius: 16px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.05);
    overflow: hidden;
  }
  
  .header {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    color: white;
    padding: 2.5rem 2rem;
    text-align: center;
  }
  
  h1 {
    font-size: 2.8rem;
    margin-bottom: 0.5rem;
    font-weight: 800;
  }
  
  .subtitle {
    font-size: 1.2rem;
    opacity: 0.95;
  }
  
  .status-success {
    background: #d1fae5;
    color: #065f46;
    border: 2px solid #10b981;
    border-radius: 12px;
    padding: 1.2rem;
    margin: 1.5rem;
    text-align: center;
    font-weight: 600;
  }
  
  .controls {
    padding: 2rem;
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
  }
  
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1.2rem;
    margin-bottom: 1.5rem;
  }
  
  .filter-group label {
    display: block;
    margin-bottom: 0.6rem;
    font-weight: 600;
    color: #475569;
    font-size: 0.95rem;
  }
  
  select, input {
    width: 100%;
    padding: 0.9rem 1rem;
    border: 2px solid #e2e8f0;
    border-radius: 10px;
    font-size: 1rem;
    transition: all 0.2s;
    background: white;
  }
  
  select:focus, input:focus {
    outline: none;
    border-color: #10b981;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.1);
  }
  
  .quick-months {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin: 1.2rem 0;
  }
  
  .month-btn {
    padding: 0.8rem 1.4rem;
    border: 2px solid #e2e8f0;
    background: white;
    border-radius: 10px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
    font-size: 0.95rem;
  }
  
  .month-btn:hover {
    border-color: #10b981;
    background: #f0fdf4;
  }
  
  .month-btn.active {
    background: #10b981;
    color: white;
    border-color: #10b981;
  }
  
  .actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  
  .btn {
    padding: 1rem 1.8rem;
    border: none;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
  }
  
  .btn-primary {
    background: #10b981;
    color: white;
  }
  
  .btn-primary:hover {
    background: #059669;
    transform: translateY(-1px);
  }
  
  .btn-secondary {
    background: #3b82f6;
    color: white;
  }
  
  .btn-secondary:hover {
    background: #2563eb;
    transform: translateY(-1px);
  }
  
  .btn-outline {
    background: white;
    color: #475569;
    border: 2px solid #e2e8f0;
  }
  
  .btn-outline:hover {
    border-color: #94a3b8;
    transform: translateY(-1px);
  }
  
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1.2rem;
    padding: 2rem;
  }
  
  .stat-card {
    background: white;
    padding: 1.8rem;
    border-radius: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    text-align: center;
    border: 2px solid #f1f5f9;
    transition: transform 0.2s;
  }
  
  .stat-card:hover {
    transform: translateY(-2px);
  }
  
  .stat-value {
    font-size: 2.4rem;
    font-weight: 800;
    color: #0f172a;
    margin-bottom: 0.6rem;
  }
  
  .stat-label {
    color: #64748b;
    font-size: 0.95rem;
    font-weight: 600;
  }
  
  .results {
    padding: 0 2rem 2rem;
  }
  
  .table-container {
    overflow-x: auto;
    border-radius: 14px;
    border: 2px solid #f1f5f9;
    background: white;
  }
  
  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 800px;
  }
  
  th {
    background: #f8fafc;
    padding: 1.2rem;
    text-align: left;
    font-weight: 700;
    color: #475569;
    border-bottom: 2px solid #e2e8f0;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  td {
    padding: 1.2rem;
    border-bottom: 1px solid #f1f5f9;
    font-size: 0.95rem;
  }
  
  tr:hover {
    background: #f8fafc;
  }
  
  .positive { 
    color: #10b981; 
    font-weight: 700;
    font-size: 1.05rem;
  }
  
  .negative { 
    color: #ef4444; 
    font-weight: 700;
    font-size: 1.05rem;
  }
  
  .refund { 
    background: #fef2f2;
  }
  
  .loading {
    text-align: center;
    padding: 3rem;
    color: #64748b;
    font-size: 1.1rem;
  }
  
  .error {
    background: #fef2f2;
    color: #dc2626;
    padding: 1.2rem;
    border-radius: 10px;
    margin: 1rem 0;
    border: 1px solid #fecaca;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Tableau de Bord Comptable</h1>
      <p class="subtitle">MCP Anam • Données WooCommerce en temps réel</p>
    </div>

    <div class="status-success">
      ✅ <strong>Connexion WooCommerce active</strong> • Export Excel fonctionnel
    </div>

    <div class="controls">
      <div class="filters">
        <div class="filter-group">
          <label>Année</label>
          <select id="yearSelect">
            <option value="2025">2025</option>
            <option value="2024">2024</option>
            <option value="2023">2023</option>
          </select>
        </div>
        
        <div class="filter-group">
          <label>Mois</label>
          <select id="monthSelect">
            <option value="1">Janvier</option>
            <option value="2">Février</option>
            <option value="3">Mars</option>
            <option value="4">Avril</option>
            <option value="5">Mai</option>
            <option value="6">Juin</option>
            <option value="7">Juillet</option>
            <option value="8">Août</option>
            <option value="9">Septembre</option>
            <option value="10" selected>Octobre</option>
            <option value="11">Novembre</option>
            <option value="12">Décembre</option>
          </select>
        </div>
        
        <div class="filter-group">
          <label>Statuts</label>
          <select id="statusSelect">
            <option value="completed">Terminées seulement</option>
            <option value="completed,processing" selected>Terminées + En traitement</option>
            <option value="completed,processing,pending">Toutes les statuts</option>
          </select>
        </div>
        
        <div class="filter-group">
          <label>Limite d'affichage</label>
          <input type="number" id="limitInput" value="100" min="1" max="1000">
        </div>
      </div>

      <div class="quick-months" id="quickMonths">
        <!-- Généré par JavaScript -->
      </div>

      <div class="actions">
        <button class="btn btn-primary" onclick="loadData()">
          📥 Charger les données
        </button>
        <button class="btn btn-secondary" onclick="exportExcel()">
          📊 Exporter Excel
        </button>
        <button class="btn btn-outline" onclick="resetFilters()">
          🔄 Réinitialiser
        </button>
        <a href="/debug-auth" class="btn btn-outline" target="_blank">
          🔧 Debug API
        </a>
      </div>
    </div>

    <div class="stats" id="statsContainer">
      <div class="stat-card">
        <div class="stat-value" id="totalOrders">-</div>
        <div class="stat-label">Commandes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="totalRevenue">-</div>
        <div class="stat-label">Chiffre d'affaires</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="totalRefunds">-</div>
        <div class="stat-label">Remboursements</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="netRevenue">-</div>
        <div class="stat-label">Revenu net</div>
      </div>
    </div>

    <div class="results">
      <div class="table-container">
        <table id="resultsTable">
          <thead>
            <tr>
              <th>Date</th>
              <th>Référence</th>
              <th>Client</th>
              <th>Nature</th>
              <th>Moyen paiement</th>
              <th>Montant</th>
              <th>Détails</th>
              <th>Ville</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody id="resultsBody">
            <tr>
              <td colspan="9" class="loading">
                ⏳ Chargement automatique en cours...
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const months = [
      "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
      "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"
    ];
    
    const currentYear = new Date().getUTCFullYear();
    const currentMonth = new Date().getUTCMonth() + 1;

    function generateQuickMonths() {
      const container = document.getElementById('quickMonths');
      months.forEach((month, index) => {
        const monthNum = index + 1;
        const btn = document.createElement('button');
        btn.className = 'month-btn';
        btn.textContent = month;
        if (monthNum === currentMonth) {
          btn.classList.add('active');
        }
        btn.onclick = () => {
          document.querySelectorAll('.month-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('monthSelect').value = monthNum;
          loadData();
        };
        container.appendChild(btn);
      });
    }

    async function loadData() {
      const year = document.getElementById('yearSelect').value;
      const month = document.getElementById('monthSelect').value;
      const statuses = document.getElementById('statusSelect').value;
      const limit = document.getElementById('limitInput').value;
      
      const resultsBody = document.getElementById('resultsBody');
      resultsBody.innerHTML = '<tr><td colspan="9" class="loading">⏳ Chargement des données WooCommerce...</td></tr>';
      
      try {
        const url = \`/orders-flat?year=\${year}&month=\${month}&statuses=\${statuses}&limit=\${limit}&include_refunds=true\`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.ok) throw new Error(data.error || 'Erreur de chargement');
        
        displayResults(data);
        updateStats(data);
        
      } catch (error) {
        resultsBody.innerHTML = \`<tr><td colspan="9" class="error">❌ Erreur: \${error.message}</td></tr>\`;
        resetStats();
      }
    }

    function displayResults(data) {
      const tbody = document.getElementById('resultsBody');
      
      if (!data.rows || data.rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="loading">📭 Aucune donnée trouvée pour cette période</td></tr>';
        return;
      }
      
      tbody.innerHTML = data.rows.map(row => \`
        <tr class="\${row.nature === 'Remboursé' ? 'refund' : ''}">
          <td>\${row.date}</td>
          <td><strong>\${row.reference}</strong></td>
          <td>\${row.prenom} \${row.nom}</td>
          <td>\${row.nature}</td>
          <td>\${row.moyen_paiement}</td>
          <td class="\${row.montant >= 0 ? 'positive' : 'negative'}">
            \${row.montant.toFixed(2)} €
          </td>
          <td style="font-size: 0.85rem; color: #64748b;">
            \${row.frais_port > 0 ? '🚚+' + row.frais_port.toFixed(2) + '€' : ''}
            \${row.remise > 0 ? '🎁-' + row.remise.toFixed(2) + '€' : ''}
          </td>
          <td>\${row.ville}</td>
          <td>\${row.status}</td>
        </tr>
      \`).join('');
    }

    function updateStats(data) {
      if (!data.rows) return;
      
      const orders = data.rows.filter(r => r.nature === 'Payé');
      const refunds = data.rows.filter(r => r.nature === 'Remboursé');
      
      const totalRevenue = orders.reduce((sum, o) => sum + o.montant, 0);
      const totalRefunds = Math.abs(refunds.reduce((sum, r) => sum + r.montant, 0));
      const netRevenue = totalRevenue - totalRefunds;
      
      document.getElementById('totalOrders').textContent = orders.length.toLocaleString();
      document.getElementById('totalRevenue').textContent = \`\${totalRevenue.toFixed(2)} €\`;
      document.getElementById('totalRefunds').textContent = \`\${totalRefunds.toFixed(2)} €\`;
      document.getElementById('netRevenue').textContent = \`\${netRevenue.toFixed(2)} €\`;
    }

    function resetStats() {
      document.getElementById('totalOrders').textContent = '-';
      document.getElementById('totalRevenue').textContent = '-';
      document.getElementById('totalRefunds').textContent = '-';
      document.getElementById('netRevenue').textContent = '-';
    }

    function exportExcel() {
      const year = document.getElementById('yearSelect').value;
      const month = document.getElementById('monthSelect').value;
      const statuses = document.getElementById('statusSelect').value;
      const limit = document.getElementById('limitInput').value;
      
      // Ajouter &format=excel pour forcer l'export CSV
      const url = \`/orders-flat?year=\${year}&month=\${month}&statuses=\${statuses}&limit=\${limit}&include_refunds=true&format=excel\`;
      
      // Créer un lien de téléchargement invisible
      const link = document.createElement('a');
      link.href = url;
      link.download = \`commandes_\${year}-\${String(month).padStart(2, '0')}.csv\`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function resetFilters() {
      document.getElementById('yearSelect').value = currentYear;
      document.getElementById('monthSelect').value = currentMonth;
      document.getElementById('statusSelect').value = 'completed,processing';
      document.getElementById('limitInput').value = '100';
      
      document.querySelectorAll('.month-btn').forEach((btn, index) => {
        btn.classList.toggle('active', index + 1 === currentMonth);
      });
      
      loadData();
    }

    // Initialisation
    document.addEventListener('DOMContentLoaded', function() {
      generateQuickMonths();
      document.getElementById('yearSelect').value = currentYear;
      // Chargement automatique
      setTimeout(loadData, 800);
    });
  </script>
</body>
</html>`);
});

// ======================= START SERVER =======================
app.listen(PORT, () => {
  console.log(`🎉 MCP SERVER FULLY OPERATIONAL on port ${PORT}`);
  console.log(`✅ WooCommerce: CONNECTED`);
  console.log(`📊 Dashboard: https://anam-mcp.onrender.com/accounting-dashboard`);
  console.log(`🔧 MCP Endpoint: /mcp`);
  console.log(`📈 Orders API: /orders-flat`);
});
