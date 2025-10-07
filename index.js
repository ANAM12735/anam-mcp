import express from "express";
import fetch from "node-fetch";
import https from "https";

const app = express();
const PORT = process.env.PORT || 10000;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";

// Agent HTTPS configuré pour éviter les blocages
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: 30000,
  minVersion: 'TLSv1.2',
  rejectUnauthorized: true
});

app.use(express.json());

// ======================= HEALTH & DEBUG =======================
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "MCP Anam", 
    version: 6,
    status: "Opérationnel"
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

// ======================= TEST DE CONNEXION AMÉLIORÉ =======================
app.get("/test-woocommerce", async (_req, res) => {
  try {
    if (!WC_URL || !WC_KEY || !WC_SECRET) {
      return res.json({ 
        ok: false, 
        error: "Variables manquantes",
        details: "Vérifiez WC_URL, WC_KEY, WC_SECRET dans Render"
      });
    }

    const testUrl = `${WC_URL}/orders?per_page=1`;
    const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
    
    console.log("🔍 Test WooCommerce URL:", testUrl);
    
    // Test avec node-fetch et agent HTTPS
    const response = await fetch(testUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "User-Agent": "MCP-Anam/1.0 (+https://anam-mcp.onrender.com)",
        "Content-Type": "application/json"
      },
      agent: httpsAgent,
      timeout: 15000
    });

    console.log("🔍 Response status:", response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      return res.json({
        ok: false,
        error: `HTTP ${response.status}`,
        details: errorText,
        type: "http_error"
      });
    }

    const data = await response.json();
    return res.json({
      ok: true,
      message: "✅ Connexion WooCommerce réussie!",
      orders_count: Array.isArray(data) ? data.length : 0,
      test_data: Array.isArray(data) && data.length > 0 ? {
        id: data[0].id,
        number: data[0].number,
        status: data[0].status,
        total: data[0].total
      } : "Aucune commande trouvée"
    });

  } catch (error) {
    console.error("❌ Test error:", error);
    return res.json({
      ok: false,
      error: `Exception: ${error.message}`,
      type: "network_error",
      suggestion: "Vérifiez le firewall/WAF de votre site"
    });
  }
});

// ======================= WOOCOMMERCE UTILS =======================
async function wooGetJSON(pathWithQuery, options = {}) {
  const { attempts = 3, timeout = 20000 } = options;
  
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("Configuration WooCommerce manquante");
  }

  const url = `${WC_URL}/${pathWithQuery.replace(/^\/+/, "")}`;
  const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");

  let lastError;
  
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`🔍 WooCommerce attempt ${attempt}/${attempts}: ${pathWithQuery}`);
      
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

      const data = await response.json();
      console.log(`✅ WooCommerce success: ${pathWithQuery}`);
      return data;

    } catch (error) {
      lastError = error;
      console.log(`❌ WooCommerce attempt ${attempt} failed:`, error.message);
      
      if (attempt === attempts) break;
      
      // Attente avant retry
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw lastError;
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
            description: "Liste les commandes WooCommerce",
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

// ======================= DASHBOARD COMPLET =======================
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>Comptabilité — MCP</title>
<style>
  body { font-family: system-ui, Arial; background: #fafafa; margin: 0; padding: 24px; }
  .container { max-width: 1200px; margin: 0 auto; background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  h1 { color: #333; margin-bottom: 8px; }
  .alert { background: #e3f2fd; border: 2px solid #2196f3; padding: 16px; border-radius: 8px; margin: 20px 0; }
  .btn { padding: 12px 20px; border: none; border-radius: 6px; background: #007bff; color: white; cursor: pointer; margin: 5px; }
  .btn:hover { background: #0056b3; }
  .btn-success { background: #28a745; }
  .btn-warning { background: #ffc107; color: #000; }
</style>
</head>
<body>
  <div class="container">
    <h1>📊 Tableau de Bord Comptable</h1>
    <p>MCP Anam • Données WooCommerce en temps réel</p>
    
    <div class="alert" id="statusAlert">
      <strong>🔧 Test de connexion en cours...</strong>
    </div>

    <div>
      <button class="btn btn-success" onclick="loadRealData()">📥 Charger les données réelles</button>
      <button class="btn btn-warning" onclick="testConnection()">🔧 Tester la connexion</button>
      <a href="/debug-auth" class="btn" target="_blank">🔍 Debug</a>
    </div>

    <div id="results" style="margin-top: 20px;"></div>
  </div>

  <script>
    async function testConnection() {
      const alert = document.getElementById('statusAlert');
      alert.innerHTML = '<strong>⏳</strong> Test de connexion WooCommerce en cours...';
      
      try {
        const response = await fetch('/test-woocommerce');
        const data = await response.json();
        
        if (data.ok) {
          alert.innerHTML = \`<strong>✅</strong> \${data.message} | Commandes: \${data.orders_count}\`;
          if (data.test_data) {
            alert.innerHTML += \` | Exemple: #\${data.test_data.number} - \${data.test_data.total}\`;
          }
        } else {
          alert.innerHTML = \`<strong>❌</strong> Erreur: \${data.error} | Détails: \${data.details || data.suggestion}\`;
        }
      } catch (error) {
        alert.innerHTML = \`<strong>❌</strong> Erreur de test: \${error.message}\`;
      }
    }

    async function loadRealData() {
      const results = document.getElementById('results');
      results.innerHTML = '<p>⏳ Chargement des commandes WooCommerce...</p>';
      
      try {
        const response = await fetch('/orders-flat?year=2025&month=10&statuses=completed,processing&limit=20&include_refunds=true');
        const data = await response.json();
        
        if (data.ok) {
          const stats = data.rows.reduce((acc, row) => {
            if (row.nature === 'Payé') {
              acc.revenue += row.montant;
              acc.orders++;
            }
            if (row.nature === 'Remboursé') acc.refunds += Math.abs(row.montant);
            return acc;
          }, { revenue: 0, refunds: 0, orders: 0 });
          
          results.innerHTML = \`
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3>💰 Statistiques Réelles</h3>
              <p><strong>\${stats.orders}</strong> commandes | <strong>\${stats.revenue.toFixed(2)} €</strong> CA | <strong>\${stats.refunds.toFixed(2)} €</strong> remboursements</p>
              <p><strong>\${(stats.revenue - stats.refunds).toFixed(2)} €</strong> revenu net</p>
            </div>
            <p>✅ Données WooCommerce chargées avec succès!</p>
          \`;
        } else {
          results.innerHTML = \`<p style="color: red;">❌ Erreur: \${data.error}</p>\`;
        }
      } catch (error) {
        results.innerHTML = \`<p style="color: red;">❌ Erreur de chargement: \${error.message}</p>\`;
      }
    }

    // Test automatique au chargement
    setTimeout(testConnection, 1000);
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
