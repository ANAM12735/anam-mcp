import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";

app.use(express.json());

// ======================= HEALTH & DEBUG =======================
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "MCP Anam", 
    version: 4,
    message: "Service en ligne - Vérification WooCommerce en cours"
  });
});

app.get("/debug-auth", (_req, res) => {
  res.json({
    MCP_TOKEN_defined: !!MCP_TOKEN,
    WC_URL_set: !!WC_URL,
    WC_KEY_set: !!WC_KEY,
    WC_SECRET_set: !!WC_SECRET,
    WC_URL_value: WC_URL || "non définie"
  });
});

// ======================= TEST DE CONNEXION WOOCOMMERCE =======================
app.get("/test-woocommerce", async (_req, res) => {
  try {
    if (!WC_URL || !WC_KEY || !WC_SECRET) {
      return res.json({ 
        ok: false, 
        error: "Variables manquantes",
        WC_URL: !!WC_URL,
        WC_KEY: !!WC_KEY, 
        WC_SECRET: !!WC_SECRET
      });
    }

    const testUrl = `${WC_URL}/orders?per_page=1`;
    const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
    
    console.log("🔍 Test WooCommerce URL:", testUrl);
    
    const response = await fetch(testUrl, {
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "User-Agent": "anam-mcp-test/1.0"
      },
      timeout: 10000
    }).catch(err => {
      return res.json({
        ok: false,
        error: `Erreur fetch: ${err.message}`,
        type: "network_error",
        url: testUrl
      });
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.json({
        ok: false,
        error: `HTTP ${response.status}: ${errorText}`,
        type: "http_error",
        status: response.status
      });
    }

    const data = await response.json();
    return res.json({
      ok: true,
      message: "Connexion WooCommerce réussie!",
      orders_count: Array.isArray(data) ? data.length : 0,
      test_data: Array.isArray(data) && data.length > 0 ? {
        id: data[0].id,
        number: data[0].number,
        status: data[0].status
      } : null
    });

  } catch (error) {
    return res.json({
      ok: false,
      error: `Exception: ${error.message}`,
      type: "exception"
    });
  }
});

// ======================= MCP ENDPOINT (SIMULÉ POUR L'INSTANT) =======================
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
            description: "Liste les commandes WooCommerce (en maintenance)",
            input_schema: {
              type: "object",
              properties: {
                status: { type: "string", default: "processing" },
                per_page: { type: "number", default: 5 }
              }
            }
          }]
        }
      });
    }

    if (method === "tools.call") {
      return res.json({
        type: "tool_error", 
        error: "Service WooCommerce temporairement indisponible - Connexion en cours de résolution"
      });
    }

    return res.json({ type: "tool_error", error: "Unknown method" });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ======================= ORDERS-FLAT (VERSION SIMULÉE) =======================
app.get("/orders-flat", async (req, res) => {
  try {
    // DONNÉES SIMULÉES en attendant la résolution WooCommerce
    const year = parseInt(req.query.year || "2025", 10);
    const month = parseInt(req.query.month || "10", 10);
    
    const simulatedData = {
      ok: true,
      year,
      month,
      statuses: req.query.statuses || "completed,processing",
      include_refunds: true,
      count: 12,
      note: "Données simulées - Connexion WooCommerce en cours de diagnostic",
      rows: [
        {
          date: "2025-10-15 14:30:00",
          reference: "1001",
          nom: "DUPONT",
          prenom: "Marie",
          nature: "Payé",
          moyen_paiement: "Carte bancaire",
          montant: 45.90,
          frais_port: 4.90,
          remise: 5.00,
          currency: "EUR",
          status: "completed",
          ville: "Paris"
        },
        {
          date: "2025-10-16 10:15:00", 
          reference: "1002",
          nom: "MARTIN",
          prenom: "Pierre",
          nature: "Payé",
          moyen_paiement: "PayPal",
          montant: 89.50,
          frais_port: 0,
          remise: 0,
          currency: "EUR", 
          status: "processing",
          ville: "Lyon"
        },
        {
          date: "2025-10-17 16:45:00",
          reference: "1003",
          nom: "BERNARD",
          prenom: "Sophie", 
          nature: "Payé",
          moyen_paiement: "Virement",
          montant: 120.00,
          frais_port: 5.00,
          remise: 10.00,
          currency: "EUR",
          status: "completed",
          ville: "Marseille"
        },
        {
          date: "2025-10-18 11:20:00",
          reference: "1001-R1", 
          nom: "DUPONT",
          prenom: "Marie",
          nature: "Remboursé",
          moyen_paiement: "Carte bancaire",
          montant: -45.90,
          frais_port: 0,
          remise: 0,
          currency: "EUR",
          status: "refunded",
          ville: "Paris"
        }
      ]
    };

    // Ajout de données supplémentaires pour les tests
    for (let i = 4; i <= 12; i++) {
      simulatedData.rows.push({
        date: `2025-10-${10 + i} 09:00:00`,
        reference: `100${i}`,
        nom: `CLIENT${i}`,
        prenom: `Prénom${i}`,
        nature: "Payé",
        moyen_paiement: i % 2 === 0 ? "Carte bancaire" : "PayPal",
        montant: 50 + (i * 10),
        frais_port: i % 3 === 0 ? 4.90 : 0,
        remise: i % 4 === 0 ? 5.00 : 0,
        currency: "EUR",
        status: i % 5 === 0 ? "processing" : "completed",
        ville: i % 2 === 0 ? "Paris" : "Lyon"
      });
    }

    res.json(simulatedData);

  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message
    });
  }
});

// ======================= DASHBOARD AMÉLIORÉ =======================
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
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #333;
    line-height: 1.6;
    padding: 20px;
    min-height: 100vh;
  }
  
  .container {
    max-width: 1200px;
    margin: 0 auto;
    background: white;
    border-radius: 20px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
    overflow: hidden;
  }
  
  .header {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    color: white;
    padding: 2rem;
    text-align: center;
  }
  
  h1 {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
    font-weight: 700;
  }
  
  .subtitle {
    font-size: 1.1rem;
    opacity: 0.9;
  }
  
  .status-alert {
    background: #fef3c7;
    border: 2px solid #f59e0b;
    border-radius: 10px;
    padding: 1rem;
    margin: 1rem;
    text-align: center;
  }
  
  .alert-warning {
    background: #fef3c7;
    color: #92400e;
    border-color: #f59e0b;
  }
  
  .alert-success {
    background: #d1fae5;
    color: #065f46;
    border-color: #10b981;
  }
  
  .controls {
    padding: 2rem;
    background: #f8fafc;
  }
  
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  
  .filter-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: #475569;
  }
  
  select, input {
    width: 100%;
    padding: 0.75rem;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    font-size: 1rem;
  }
  
  .actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  
  .btn {
    padding: 0.875rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .btn-primary {
    background: #10b981;
    color: white;
  }
  
  .btn-primary:hover {
    background: #059669;
  }
  
  .btn-secondary {
    background: #3b82f6;
    color: white;
  }
  
  .btn-secondary:hover {
    background: #2563eb;
  }
  
  .btn-outline {
    background: white;
    color: #475569;
    border: 2px solid #e2e8f0;
  }
  
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    padding: 2rem;
  }
  
  .stat-card {
    background: white;
    padding: 1.5rem;
    border-radius: 12px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.05);
    text-align: center;
    border: 2px solid #f1f5f9;
  }
  
  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 0.5rem;
  }
  
  .stat-label {
    color: #64748b;
    font-size: 0.9rem;
  }
  
  .results {
    padding: 0 2rem 2rem;
  }
  
  .table-container {
    overflow-x: auto;
    border-radius: 12px;
    border: 2px solid #f1f5f9;
  }
  
  table {
    width: 100%;
    border-collapse: collapse;
  }
  
  th {
    background: #f8fafc;
    padding: 1rem;
    text-align: left;
    font-weight: 600;
    color: #475569;
    border-bottom: 2px solid #e2e8f0;
  }
  
  td {
    padding: 1rem;
    border-bottom: 1px solid #f1f5f9;
  }
  
  tr:hover {
    background: #f8fafc;
  }
  
  .positive { color: #10b981; font-weight: 600; }
  .negative { color: #ef4444; font-weight: 600; }
  .refund { background: #fef2f2; }
  
  .loading {
    text-align: center;
    padding: 3rem;
    color: #64748b;
  }
  
  .error {
    background: #fef2f2;
    color: #dc2626;
    padding: 1rem;
    border-radius: 8px;
    margin: 1rem 0;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Tableau de Bord Comptable</h1>
      <p class="subtitle">MCP Anam • Gestion WooCommerce</p>
    </div>

    <div class="status-alert alert-warning" id="statusAlert">
      <strong>⚠️ Mode démonstration</strong> - Connexion WooCommerce en cours de diagnostic
    </div>

    <div class="controls">
      <div class="filters">
        <div class="filter-group">
          <label>Année</label>
          <select id="yearSelect">
            <option value="2025">2025</option>
            <option value="2024">2024</option>
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
            <option value="completed">Terminées</option>
            <option value="completed,processing" selected>Terminées + Traitement</option>
          </select>
        </div>
        
        <div class="filter-group">
          <label>Limite</label>
          <input type="number" id="limitInput" value="100" min="1" max="1000">
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" onclick="loadData()">
          📥 Charger les données
        </button>
        <button class="btn btn-secondary" onclick="exportData()">
          📊 Exporter les données
        </button>
        <button class="btn btn-outline" onclick="testConnection()">
          🔧 Tester la connexion
        </button>
        <a href="/debug-auth" class="btn btn-outline" target="_blank">
          🔍 Debug détaillé
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
                ⏳ Cliquez sur "Charger les données" pour commencer
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function loadData() {
      const year = document.getElementById('yearSelect').value;
      const month = document.getElementById('monthSelect').value;
      const statuses = document.getElementById('statusSelect').value;
      const limit = document.getElementById('limitInput').value;
      
      const resultsBody = document.getElementById('resultsBody');
      resultsBody.innerHTML = '<tr><td colspan="9" class="loading">⏳ Chargement des données en cours...</td></tr>';
      
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
        tbody.innerHTML = '<tr><td colspan="9" class="loading">📭 Aucune donnée trouvée</td></tr>';
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
          <td>
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
      
      document.getElementById('totalOrders').textContent = orders.length;
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

    async function testConnection() {
      const alert = document.getElementById('statusAlert');
      alert.className = 'status-alert alert-warning';
      alert.innerHTML = '<strong>⏳</strong> Test de connexion en cours...';
      
      try {
        const response = await fetch('/test-woocommerce');
        const data = await response.json();
        
        if (data.ok) {
          alert.className = 'status-alert alert-success';
          alert.innerHTML = \`<strong>✅</strong> \${data.message}\`;
        } else {
          alert.className = 'status-alert alert-warning';
          alert.innerHTML = \`<strong>❌</strong> Erreur: \${data.error} (Type: \${data.type})\`;
        }
      } catch (error) {
        alert.className = 'status-alert alert-warning';
        alert.innerHTML = \`<strong>❌</strong> Erreur de test: \${error.message}\`;
      }
    }

    function exportData() {
      const year = document.getElementById('yearSelect').value;
      const month = document.getElementById('monthSelect').value;
      const statuses = document.getElementById('statusSelect').value;
      const limit = document.getElementById('limitInput').value;
      
      const url = \`/orders-flat?year=\${year}&month=\${month}&statuses=\${statuses}&limit=\${limit}&include_refunds=true\`;
      window.open(url, '_blank');
    }

    // Chargement automatique au démarrage
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(loadData, 1000);
    });
  </script>
</body>
</html>`);
});

// ======================= START SERVER =======================
app.listen(PORT, () => {
  console.log(`✅ MCP server running on port ${PORT}`);
  console.log(`🔧 Test URL: https://anam-mcp.onrender.com/test-woocommerce`);
  console.log(`🔧 Dashboard: https://anam-mcp.onrender.com/accounting-dashboard`);
});
