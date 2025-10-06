import express from "express";
import fetch from "node-fetch";

// ---------- CONFIG ----------
const PORT     = process.env.PORT || 10000;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const WC_URL    = (process.env.WC_URL || "").replace(/\/+$/,""); // ex: https://anam-and-styles.com/wp-json/wc/v3
const WC_KEY    = process.env.WC_KEY || "";     // ck_...
const WC_SECRET = process.env.WC_SECRET || "";  // cs_...

// ---------- APP ----------
const app = express();
app.use(express.json());

// Health
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam", version: 1 });
});

// Debug token
app.get("/debug-auth", (_req, res) => {
  res.json({
    MCP_TOKEN_defined: !!MCP_TOKEN,
    WC_URL_set: !!WC_URL,
    WC_KEY_set: !!WC_KEY,
    WC_SECRET_set: !!WC_SECRET,
  });
});

// Auth Bearer pour /mcp
function mcpAuth(req, res, next) {
  if (!MCP_TOKEN) {
    return res.status(500).json({ error: "MCP_TOKEN non défini côté serveur" });
  }
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization Bearer requis" });
  }
  const token = auth.slice("Bearer ".length);
  if (token !== MCP_TOKEN) {
    return res.status(403).json({ error: "Jeton invalide" });
  }
  next();
}

// Utilitaire fetch Woo (Basic Auth ck/cs) + gestion d’erreur détaillée
async function wooGetJSON(pathWithQuery) {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set (WC_URL, WC_KEY, WC_SECRET).");
  }
  const url = `${WC_URL.replace(/\/+$/,"")}/${pathWithQuery.replace(/^\/+/, "")}`;
  const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");

  const r = await fetch(url, {
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    },
    timeout: 20000,
  });

  const text = await r.text();
  if (!r.ok) {
    // Essaie de parser JSON d’erreur Woo
    try {
      const j = JSON.parse(text);
      const msg = j.message || j.error || JSON.stringify(j);
      throw new Error(`Woo ${r.status}: ${msg}`);
    } catch {
      throw new Error(`Woo ${r.status}: ${text}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Réponse Woo non-JSON: " + text.slice(0, 500));
  }
}

// ------- MCP endpoint -------
app.post("/mcp", mcpAuth, async (req, res) => {
  try {
    const { method, params } = req.body || {};

    // 1) tools.list pour tester vite
    if (method === "tools.list") {
      return res.json({
        type: "tool_result",
        content: {
          tools: [
            {
              name: "getOrders",
              description: "Liste les commandes WooCommerce (status et per_page).",
              input_schema: {
                type: "object",
                properties: {
                  status:   { type: "string", default: "processing" },
                  per_page: { type: "number",  default: 5 }
                },
                required: ["status"]
              }
            }
          ]
        }
      });
    }

    // 2) tools.call
    if (method === "tools.call") {
      const name = params?.name;
      const args = params?.arguments || {};

      if (name === "getOrders") {
        const status   = String(args.status || "processing");
        const per_page = Math.min(Math.max(parseInt(args.per_page || 5, 10), 1), 50);

        // Exemple d’URL Woo (WC_URL DOIT être: https://anam-and-styles.com/wp-json/wc/v3)
        const q = `orders?status=${encodeURIComponent(status)}&per_page=${per_page}`;

        const data = await wooGetJSON(q);

        // On renvoie un condensé (id, number, total, date, client)
        const orders = (Array.isArray(data) ? data : []).map(o => ({
          id: o.id,
          number: o.number,
          total: o.total,
          currency: o.currency,
          date_created: o.date_created,
          status: o.status,
          customer: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
          city: o.shipping?.city || ""
        }));

        return res.json({ type: "tool_result", content: orders });
      }

      return res.json({ type: "tool_error", error: `Unknown tool: ${name}` });
    }

    return res.json({ type: "tool_error", error: "Unknown method" });
  } catch (err) {
    console.error("MCP ERROR:", err);
    // ⚠️ On retourne l’erreur réelle pour déboguer
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Démarrage
app.listen(PORT, () => {
  console.log(`✅ MCP server on ${PORT}`);
});
// ---------- ROUTES COMPTA (à placer AVANT app.listen) ----------

// Petite page de test pour voir que le dashboard répond
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr"><meta charset="utf-8" />
<title>Comptabilité — MCP</title>
<body style="font-family:system-ui,Arial;padding:24px">
  <h1>Comptabilité — MCP OK ✅</h1>
  <p>Utilisez <code>/orders-flat</code> pour récupérer la liste à plat (Excel-like).</p>
  <p>Exemple: <code>/orders-flat?year=2025&month=10&statuses=completed,processing&limit=500&include_refunds=true&mode=excel</code></p>
</body></html>`);
});

// Utilitaire: bornes d'un mois (UTC)
function monthRange(year, month) {
  // month = 1..12
  const y = parseInt(year, 10);
  const m = parseInt(month, 10) - 1;
  const afterISO = new Date(Date.UTC(y, m, 1, 0, 0, 0)).toISOString();
  const beforeISO = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString();
  return { afterISO, beforeISO };
}

// Récupère tous les refunds d'une commande
async function wooGetRefunds(orderId) {
  return await wooGetJSON(`orders/${orderId}/refunds`);
}

/**
 * /orders-flat
 * Query:
 *  - year=2025
 *  - month=10
 *  - statuses=completed,processing
 *  - limit=500 (max lignes retournées; côté Woo on pagine par 100)
 *  - include_refunds=true|false (ajoute des lignes "Remboursé" négatives)
 *  - mode=excel|woo (juste informatif)
 */
app.get("/orders-flat", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);
    const month = parseInt(req.query.month || (new Date().getUTCMonth() + 1), 10);
    const statuses = String(req.query.statuses || "completed,processing")
      .split(",").map(s => s.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "500", 10), 2000));
    const includeRefunds = String(req.query.include_refunds || "true").toLowerCase() === "true";

    if (!WC_URL || !WC_KEY || !WC_SECRET) {
      return res.status(500).json({ ok:false, error:"WooCommerce credentials not set" });
    }

    const { afterISO, beforeISO } = monthRange(year, month);

    // Récupération paginée des commandes (on limite par 100 par requête)
    const rows = [];
    for (const status of statuses) {
      let page = 1;
      while (rows.length < limit) {
        const per_page = Math.min(100, limit - rows.length);
        const q = `orders?status=${encodeURIComponent(status)}&per_page=${per_page}&page=${page}&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`;
        const data = await wooGetJSON(q);
        if (!Array.isArray(data) || data.length === 0) break;

        for (const o of data) {
          // Ligne "Paiement"
          rows.push({
            date: (o.date_created || "").replace("T"," ").replace("Z",""),
            reference: o.number,
            nom: (o.billing?.last_name || "").toString().trim(),
            prenom: (o.billing?.first_name || "").toString().trim(),
            nature: "Payé",
            moyen_paiement: o.payment_method_title || o.payment_method || "",
            montant: parseFloat(o.total || "0") || 0,
            currency: o.currency || "EUR",
            status: o.status || "",
            ville: o.billing?.city || o.shipping?.city || ""
          });

          // Lignes "Remboursé" (si demandé)
          if (includeRefunds) {
            const refunds = await wooGetRefunds(o.id);
            if (Array.isArray(refunds) && refunds.length > 0) {
              for (const r of refunds) {
                rows.push({
                  date: (r.date_created || o.date_created || "").replace("T"," ").replace("Z",""),
                  reference: `${o.number}-R${r.id}`,
                  nom: (o.billing?.last_name || "").toString().trim(),
                  prenom: (o.billing?.first_name || "").toString().trim(),
                  nature: "Remboursé",
                  moyen_paiement: o.payment_method_title || o.payment_method || "",
                  montant: -Math.abs(parseFloat(r.amount || "0") || 0),
                  currency: o.currency || "EUR",
                  status: "refunded",
                  ville: o.billing?.city || o.shipping?.city || ""
                });
              }
            }
          }

          if (rows.length >= limit) break;
        }
        if (data.length < per_page || rows.length >= limit) break;
        page++;
      }
      if (rows.length >= limit) break;
    }

    return res.json({
      ok: true,
      year, month, statuses, include_refunds: includeRefunds,
      count: rows.length,
      rows
    });
  } catch (e) {
    console.error("orders-flat ERROR:", e);
    res.status(500).json({ ok:false, error: e?.message || "Server error" });
  }
});
