import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// 🔐 CONFIGURATION
// ===============================
const PORT = process.env.PORT || 10000;
const WOO_URL = "https://anam-and-styles.com/wp-json/wc/v3";
const WOO_KEY = process.env.WC_KEY;
const WOO_SECRET = process.env.WC_SECRET;
const MCP_TOKEN = process.env.MCP_TOKEN;

// ===============================
// 🔒 Middleware d’authentification
// ===============================
app.use((req, res, next) => {
  const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== MCP_TOKEN) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
});

// ===============================
// 🔧 Fonctions utilitaires WooCommerce
// ===============================
async function fetchFromWoo(endpoint) {
  const url = `${WOO_URL}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${WOO_KEY}:${WOO_SECRET}`).toString("base64"),
    },
  });
  if (!response.ok) {
    throw new Error(`Erreur WooCommerce ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

// Récupère toutes les commandes pour un statut donné et une période
async function fetchOrdersPaged({ status, afterISO, beforeISO }) {
  const url = `/orders?status=${status}&after=${afterISO}&before=${beforeISO}&per_page=100`;
  const orders = await fetchFromWoo(url);
  return orders || [];
}

// Récupère les remboursements d'une commande
async function fetchRefundsForOrder(orderId) {
  try {
    const refunds = await fetchFromWoo(`/orders/${orderId}/refunds`);
    return refunds || [];
  } catch {
    return [];
  }
}

// ===============================
// 🧮 PAGE COMPTABILITÉ
// ===============================
app.get("/accounting", async (req, res) => {
  try {
    const year = parseInt(req.query.year || "2025");
    const statuses = (req.query.statuses || "completed,processing")
      .split(",")
      .map((s) => s.trim());
    const months = Array.from({ length: 12 }, (_, i) => i + 1);

    const results = [];

    for (const month of months) {
      const afterISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
      const beforeISO = new Date(Date.UTC(year, month, 1)).toISOString();

      let totalSales = 0,
        totalRefunds = 0,
        count = 0,
        refundsCount = 0;

      for (const status of statuses) {
        const orders = await fetchOrdersPaged({ status, afterISO, beforeISO });
        for (const o of orders) {
          const total = parseFloat(o.total);
          totalSales += total;
          count++;

          const refunds = await fetchRefundsForOrder(o.id);
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
        refundsCount,
      });
    }

    res.json({ ok: true, year, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 📊 PAGE HTML DU TABLEAU
// ===============================
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
          Token: <input id="token" type="password" value="" size="40" />
          Année: <input id="year" type="number" value="2025" style="width:80px" />
          Statuts: <input id="statuses" type="text" value="completed,processing" size="25" />
          Preview (limite nb cmd / status): <input id="limit" type="number" value="25" style="width:80px" />
          <button onclick="loadData()">Actualiser</button>
          <button onclick="exportExcel()">Exporter CSV détaillé</button>
        </div>
        <p id="status"></p>
        <table id="tbl">
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
        </table>
        <script>
          async function loadData(){
            const token = document.getElementById('token').value;
            const year = document.getElementById('year').value;
            const statuses = document.getElementById('statuses').value;
            const limit = document.getElementById('limit').value;
            document.getElementById('status').innerText = 'Chargement...';
            const url = \`/accounting?year=\${year}&statuses=\${statuses}&limit=\${limit}&token=\${token}\`;
            const res = await fetch(url);
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

          function exportExcel(){
            const token = document.getElementById('token').value;
            const year = document.getElementById('year').value;
            const statuses = document.getElementById('statuses').value;
            const url = \`/orders-excel?year=\${year}&month=10&statuses=\${statuses}&limit=500&include_refunds=true&format=csv&token=\${token}\`;
            window.open(url, '_blank');
          }
        </script>
      </body>
    </html>
  `);
});

// ===============================
// 📋 EXPORT DÉTAILLÉ POUR EXCEL
// ===============================
function asMoney(n) {
  const v = parseFloat(n || 0);
  return Math.round(v * 100) / 100;
}
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
  return (iso || "").replace("T"," ").replace("Z","");
}

async function getFlatRows({ year, month, statuses, limit = 500, includeRefunds = true }) {
  let afterISO, beforeISO;
  if (year && month) {
    afterISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    beforeISO = new Date(Date.UTC(year, month, 1)).toISOString();
  } else {
    const now = new Date();
    beforeISO = now.toISOString();
    afterISO = new Date(now.getTime() - 30*24*3600*1000).toISOString();
  }

  const wanted = (statuses || ["completed","processing"]).map(s => s.trim()).filter(Boolean);
  let ordersAll = [];
  for (const status of wanted) {
    const orders = await fetchOrdersPaged({ status, afterISO, beforeISO });
    ordersAll.push(...orders.slice(0, limit));
  }

  const rows = [];
  for (const o of ordersAll) {
    const montant = asMoney(o.total);
    rows.push({
      date: toDateTimeLocal(o.date_created),
      reference: o.number || o.id,
      client: \`\${o.billing?.first_name || ""} \${o.billing?.last_name || ""}\`.trim(),
      nature: natureFromStatus(o.status),
      paiement: o.payment_method_title || "",
      montant: montant,
    });

    if (includeRefunds) {
      const refunds = await fetchRefundsForOrder(o.id);
      for (const r of refunds) {
        const rm = asMoney(r.amount) * -1;
        rows.push({
          date: toDateTimeLocal(r.date_created || o.date_created),
          reference: o.number || o.id,
          client: \`\${o.billing?.first_name || ""} \${o.billing?.last_name || ""}\`.trim(),
          nature: "Remboursée",
          paiement: o.payment_method_title || "",
          montant: rm,
        });
      }
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

app.get("/orders-excel", async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const month = parseInt(req.query.month);
    const statuses = (req.query.statuses || "completed,processing").split(",").map(s => s.trim());
    const limit = parseInt(req.query.limit || 500);
    const include_refunds = String(req.query.include_refunds || "true") === "true";
    const format = (req.query.format || "json").toLowerCase();

    const rows = await getFlatRows({ year, month, statuses, limit, includeRefunds: include_refunds });

    if (format === "csv") {
      const header = ["Date","Référence","Nom du client","Nature","Paiement","Montant encaissé"];
      const lines = [header.join(",")];
      for (const r of rows) {
        const esc = v => \`"\${String(v || "").replace(/"/g, '""')}"\`;
        lines.push([esc(r.date), esc(r.reference), esc(r.client), esc(r.nature), esc(r.paiement), esc(r.montant.toFixed(2).replace(".", ","))].join(","));
      }
      const csv = lines.join("\\r\\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=ventes_detaillees.csv");
      return res.send(csv);
    }

    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===============================
// 🚀 DÉMARRAGE
// ===============================
app.listen(PORT, () => {
  console.log("MCP server running on port", PORT);
});
