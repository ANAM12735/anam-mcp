import express from "express";
import https from "https";
import { setTimeout as sleep } from "timers/promises";

// ======================= CONFIG =======================
const PORT = process.env.PORT || 10000;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";

// Agent HTTPS robuste
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: 30000,
  minVersion: 'TLSv1.2',
  rejectUnauthorized: true
});

// ======================= APP =======================
const app = express();
app.use(express.json());

// Health
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam", version: 3 });
});

// Debug
app.get("/debug-auth", (_req, res) => {
  res.json({
    MCP_TOKEN_defined: !!MCP_TOKEN,
    WC_URL_set: !!WC_URL,
    WC_KEY_set: !!WC_KEY,
    WC_SECRET_set: !!WC_SECRET,
  });
});

// ======================= WOOCOMMERCE UTILS =======================
function requireWooCreds() {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set");
  }
}

async function wooGetJSON(pathWithQuery, options = {}) {
  requireWooCreds();
  const { attempts = 3, timeout = 25000 } = options;
  
  const url = `${WC_URL}/${pathWithQuery.replace(/^\/+/, "")}`;
  const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");

  let lastError;
  
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`🔍 WooCommerce attempt ${attempt}/${attempts}: ${pathWithQuery}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
          "User-Agent": "anam-mcp/1.0",
          "Content-Type": "application/json",
        },
        agent: httpsAgent,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

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
      
      // Si c'est la dernière tentative ou erreur non-réseau, on arrête
      if (attempt === attempts || !isNetworkError(error)) {
        break;
      }
      
      // Attente exponentielle avant retry
      await sleep(1000 * attempt);
    }
  }

  throw lastError;
}

function isNetworkError(error) {
  const message = String(error.message || error);
  return message.includes("socket") || 
         message.includes("TLS") || 
         message.includes("ECONN") ||
         message.includes("fetch failed") ||
         message.includes("aborted") ||
         message.includes("network");
}

async function wooGetRefunds(orderId) {
  return wooGetJSON(`orders/${orderId}/refunds`, { attempts: 2 });
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
            description: "Liste les commandes WooCommerce",
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

// ======================= ORDERS-FLAT =======================
app.get("/orders-flat", async (req, res) => {
  try {
    console.log("📦 Début /orders-flat");
    
    const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);
    const month = parseInt(req.query.month || (new Date().getUTCMonth() + 1), 10);
    const statuses = String(req.query.statuses || "completed,processing")
      .split(",").map(s => s.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 1000));
    const includeRefunds = String(req.query.include_refunds || "true").toLowerCase() === "true";

    requireWooCreds();
    const { afterISO, beforeISO } = monthRange(year, month);

    const rows = [];
    
    for (const status of statuses) {
      let page = 1;
      let hasMore = true;

      while (hasMore && rows.length < limit) {
        const per_page = Math.min(100, limit - rows.length);
        const query = `orders?status=${status}&per_page=${per_page}&page=${page}&after=${afterISO}&before=${beforeISO}`;
        
        console.log(`📥 Fetching ${status} page ${page}...`);
        
        const data = await wooGetJSON(query, { attempts: 2 });
        
        if (!Array.isArray(data) || data.length === 0) {
          hasMore = false;
          break;
        }

        for (const order of data) {
          // Calcul du montant réel avec frais et promos
          const total = parseFloat(order.total || "0") || 0;
          const shipping = parseFloat(order.shipping_total || "0") || 0;
          const discount = Math.abs(parseFloat(order.discount_total || "0") || 0);
          const montantReel = total + shipping - discount;

          // Ligne commande
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

          // Remboursements
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
              console.error("⚠️ Erreur remboursements:", refundError.message);
            }
          }

          if (rows.length >= limit) break;
        }

        if (data.length < per_page) hasMore = false;
        page++;
        
        // Petite pause entre les pages pour éviter de surcharger
        if (hasMore && rows.length < limit) {
          await sleep(100);
        }
      }
      
      if (rows.length >= limit) break;
    }

    console.log(`✅ /orders-flat terminé: ${rows.length} lignes`);
    
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
    console.error("❌ orders-flat ERROR:", error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      details: "Erreur de connexion WooCommerce"
    });
  }
});

// ======================= DASHBOARD =======================
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>Comptabilité — MCP</title>
<style>
  body { font-family: system-ui, Arial; background: #fafafa; margin: 0; padding: 24px; }
  h1 { color: #333; }
  button { margin: 4px; padding: 8px 14px; border: none; border-radius: 6px; background: #007bff; color: white; cursor: pointer; }
  button:hover { background: #0056b3; }
  #output { margin-top: 20px; white-space: pre; background: #fff; padding: 16px; border-radius: 6px; }
</style>
</head>
<body>
  <h1>📊 Comptabilité — MCP</h1>
  <p>Interface simplifiée - Les données se chargent automatiquement</p>
  <div id="output">Chargement...</div>

<script>
async function loadData() {
  try {
    const response = await fetch('/orders-flat?year=2025&month=10&statuses=completed,processing&limit=50&include_refunds=true');
    const data = await response.json();
    
    if (data.ok) {
      const stats = data.rows.reduce((acc, row) => {
        if (row.nature === 'Payé') acc.revenue += row.montant;
        if (row.nature === 'Remboursé') acc.refunds += Math.abs(row.montant);
        return acc;
      }, { revenue: 0, refunds: 0 });
      
      document.getElementById('output').innerHTML = \`
        <h3>💰 Statistiques Octobre 2025</h3>
        <p>Chiffre d'affaires: <strong>\${stats.revenue.toFixed(2)} €</strong></p>
        <p>Remboursements: <strong>\${stats.refunds.toFixed(2)} €</strong></p>
        <p>Revenu net: <strong>\${(stats.revenue - stats.refunds).toFixed(2)} €</strong></p>
        <p>\${data.count} lignes au total</p>
      \`;
    } else {
      document.getElementById('output').innerHTML = 'Erreur: ' + data.error;
    }
  } catch (error) {
    document.getElementById('output').innerHTML = 'Erreur de connexion: ' + error.message;
  }
}

loadData();
</script>
</body>
</html>`);
});

// ======================= START SERVER =======================
app.listen(PORT, () => {
  console.log(`✅ MCP server running on port ${PORT}`);
  console.log(`🔧 WooCommerce URL: ${WC_URL}`);
});
