import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WOO_URL = "https://anam-and-styles.com/wp-json/wc/v3";
const WOO_KEY = process.env.WC_KEY;
const WOO_SECRET = process.env.WC_SECRET;
const MCP_TOKEN = process.env.MCP_TOKEN;

// Middleware d’authentification
app.use((req, res, next) => {
  const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== MCP_TOKEN) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
});

// Fonction utilitaire pour récupérer depuis WooCommerce
async function fetchFromWoo(endpoint) {
  const response = await fetch(`${WOO_URL}${endpoint}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${WOO_KEY}:${WOO_SECRET}`).toString("base64"),
    },
  });
  if (!response.ok) {
    throw new Error(`Erreur WooCommerce ${response.status}`);
  }
  return await response.json();
}

// Page principale
app.get("/", (req, res) => res.send("✅ MCP actif"));

// Tableau de comptabilité
app.get("/accounting-dashboard", (req, res) => {
  res.send(`
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Comptabilité — Ventes & Remboursements</title>
    <style>
      body { font-family: Arial; margin: 30px; }
      table { border-collapse: collapse; width: 100%; margin-top: 15px; }
      th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: right; }
      th { background: #eee; text-align: center; }
      input, button { margin: 4px; padding: 4px; }
    </style>
  </head>
  <body>
    <h2>Comptabilité — Ventes & Remboursements</h2>
    <div>
      Token: <input id="token" type="password" size="40" />
      Année: <input id="year" type="number" value="2025" style="width:80px" />
      Statuts: <input id="statuses" type="text" value="completed,processing" size="25" />
      <button onclick="loadData()">Actualiser</button>
    </div>
    <p id="status"></p>
    <table id="tbl">
      <thead><tr>
        <th>Mois</th><th>Nb commandes</th><th>Ventes brutes (EUR)</th><th>Nb remboursements</th><th>Remboursements (EUR)</th><th>Net (EUR)</th>
      </tr></thead>
      <tbody></tbody>
    </table>
    <script>
      async function loadData(){
        const token = document.getElementById('token').value;
        const year = document.getElementById('year').value;
        const statuses = document.getElementById('statuses').value;
        document.getElementById('status').innerText = 'Chargement...';
        const res = await fetch(\`/accounting?year=\${year}&statuses=\${statuses}&token=\${token}\`);
        const data = await res.json();
        const tbody = document.querySelector('#tbl tbody');
        tbody.innerHTML = '';
        if(!data.ok){ document.getElementById('status').innerText = 'Erreur'; return; }
        for(const r of data.results){
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td>\${year}-\${String(r.month).padStart(2,'0')}</td>
            <td>\${r.count}</td>
            <td>\${r.totalSales.toFixed(2)}</td>
            <td>\${r.refundsCount}</td>
            <td>\${r.totalRefunds.toFixed(2)}</td>
            <td>\${r.net.toFixed(2)}</td>\`;
          tbody.appendChild(tr);
        }
        document.getElementById('status').innerText = 'OK';
      }
    </script>
  </body>
  </html>
  `);
});

// Endpoint comptable
app.get("/accounting", async (req, res) => {
  try {
    const year = parseInt(req.query.year || "2025");
    const statuses = (req.query.statuses || "completed,processing").split(",").map(s => s.trim());
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    const results = [];

    for (const month of months) {
      const afterISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      const beforeISO = new Date(Date.UTC(year, month, 1)).toISOString();
      let totalSales = 0, totalRefunds = 0, count = 0, refundsCount = 0;

      for (const status of statuses) {
        const commandes = await fetchFromWoo(`/orders?status=${status}&after=${afterISO}&before=${beforeISO}&per_page=50`);
        for (const o of commandes) {
          totalSales += parseFloat(o.total);
          count++;
          const refunds = await fetchFromWoo(`/orders/${o.id}/refunds`);
          for (const r of refunds) {
            totalRefunds += parseFloat(r.amount);
            refundsCount++;
          }
        }
      }

      results.push({
        month,
        totalSales,
        totalRefunds,
        net: totalSales - totalRefunds,
        count,
        refundsCount
      });
    }

    res.json({ ok: true, year, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lancement serveur
app.listen(PORT, () => console.log("✅ MCP server running on port", PORT));
