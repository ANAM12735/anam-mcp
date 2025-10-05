import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Configuration depuis Render (variables d'environnement)
const WC_URL = process.env.WC_URL || "";
const WC_KEY = process.env.WC_KEY || "";
const WC_SECRET = process.env.WC_SECRET || "";
const MCP_TOKEN = process.env.MCP_TOKEN || "";

// Test rapide
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "🚀 MCP Anam & Styles est en ligne !" });
});

// Sécurité simple (optionnelle)
app.use("/mcp", (req, res, next) => {
  if (!MCP_TOKEN) return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== MCP_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Endpoint MCP
app.post("/mcp", async (req, res) => {
  const { method, params } = req.body || {};

  if (method === "tools.list") {
    return res.json({
      type: "tool_result",
      content: {
        tools: [
          {
            name: "getOrders",
            description: "Liste les commandes WooCommerce (status=processing par défaut).",
            input_schema: {
              type: "object",
              properties: {
                status: { type: "string", default: "processing" },
                per_page: { type: "number", default: 10 }
              }
            }
          }
        ]
      }
    });
  }

  if (method === "tools.call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "getOrders") {
      try {
        const status = args.status || "processing";
        const per_page = Math.min(Math.max(parseInt(args.per_page || 10, 10), 1), 50);
        const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${per_page}`;
        const { data } = await axios.get(url, {
          auth: { username: WC_KEY, password: WC_SECRET },
          timeout: 10000,
        });

        const orders = (Array.isArray(data) ? data : []).map(o => ({
          id: o.id,
          number: o.number,
          total: o.total,
          date_created: o.date_created,
          status: o.status,
          customer: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
          city: o.shipping?.city || ""
        }));

        return res.json({ type: "tool_result", content: orders });
      } catch (e) {
        return res.json({ type: "tool_error", error: e?.message || "Erreur WooCommerce" });
      }
    }

    return res.json({ type: "tool_error", error: `Unknown tool: ${name}` });
  }

  return res.json({ type: "tool_error", error: "Unknown method" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ MCP Anam & Styles actif sur le port ${PORT}`));
