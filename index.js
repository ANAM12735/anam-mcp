import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";

app.use(express.json());

// ---------- Health & Debug ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam", version: 2 });
});

app.get("/debug-auth", (_req, res) => {
  res.json({
    MCP_TOKEN_defined: !!MCP_TOKEN,
    WC_URL_set: !!WC_URL,
    WC_KEY_set: !!WC_KEY,
    WC_SECRET_set: !!WC_SECRET,
  });
});

// ---------- MCP Endpoint ----------
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

        // Appel WooCommerce
        const url = `${WC_URL}/orders?status=${encodeURIComponent(status)}&per_page=${per_page}`;
        const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
        
        const response = await fetch(url, {
          headers: {
            Authorization: `Basic ${basic}`,
            Accept: "application/json",
            "User-Agent": "anam-mcp/1.0"
          }
        });

        if (!response.ok) throw new Error(`WooCommerce error: ${response.status}`);
        const data = await response.json();

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
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---------- COMPTA ROUTES ----------
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<meta charset="utf-8"/>
<title>Comptabilité — MCP</title>
<body style="font-family:system-ui,Arial;padding:24px">
  <h1>📊 Comptabilité — MCP OK ✅</h1>
  <p>Interface comptable opérationnelle</p>
  <p><a href="/orders-flat?year=2025&month=10&statuses=completed&limit=10">Testez les données brutes</a></p>
</body></html>`);
});

app.get("/orders-flat", async (req, res) => {
  try {
    res.json({
      ok: true,
      message: "Route orders-flat fonctionne!",
      params: req.query
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ MCP server running on port ${PORT}`);
});
