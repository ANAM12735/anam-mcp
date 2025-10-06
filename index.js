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
