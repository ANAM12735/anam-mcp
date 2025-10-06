// index.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- WooCommerce config via env ---
const WC_URL    = process.env.WC_URL || "";     // ex: https://anam-and-styles.com/wp-json/wc/v3/
const WC_KEY    = process.env.WC_KEY || "";     // ck_...
const WC_SECRET = process.env.WC_SECRET || "";  // cs_...

// --- Health check ---
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam & Styles", version: 1 });
});

// --- Debug (ne révèle pas la valeur du token) ---
app.get("/debug-auth", (_req, res) => {
  const isSet = !!(process.env.MCP_TOKEN && String(process.env.MCP_TOKEN).length > 0);
  res.json({ MCP_TOKEN_defined: isSet });
});

// --- Auth Bearer (activée seulement si MCP_TOKEN est défini) ---
app.use((req, res, next) => {
  const token = process.env.MCP_TOKEN || "";
  if (!token) return next(); // pas de token => aucune auth requise
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// --- MCP endpoint ---
app.post("/mcp", async (req, res) => {
  const { method, params } = req.body || {};

  // 1) Déclarer les outils disponibles
  if (method === "tools.list") {
    return res.json({
      type: "tool_result",
      content: {
        tools: [
          {
            name: "getOrders",
            description:
              "Liste les commandes WooCommerce (status=processing par défaut).",
            input_schema: {
              type: "object",
              properties: {
                status:    { type: "string",  default: "processing" },
                per_page:  { type: "number",  default: 10 }
              }
            }
          }
        ]
      }
    });
  }

  // 2) Appeler un outil
  if (method === "tools.call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "getOrders") {
      // Vérif des credentials WooCommerce
      if (!WC_URL || !WC_KEY || !WC_SECRET) {
        return res.json({
          type: "tool_error",
          error: "WooCommerce credentials not set"
        });
      }

      try {
        const status   = (args.status || "processing").trim();
        const per_page = Math.min(Math.max(parseInt(args.per_page || 10, 10), 1), 50);

        const url = `${WC_URL}orders?status=${encodeURIComponent(status)}&per_page=${per_page}`;

        const { data } = await axios.get(url, {
          auth: { username: WC_KEY, password: WC_SECRET },
          timeout: 15000,
          // on laisse axios lever si status >= 400
        });

        const orders = (Array.isArray(data) ? data : []).map(o => ({
          id:           o.id,
          number:       o.number,
          total:        o.total,
          currency:     o.currency,
          date_created: o.date_created,
          status:       o.status,
          customer:     `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
          city:         o.shipping?.city || ""
        }));

        return res.json({ type: "tool_result", content: orders });
      } catch (e) {
        // Axios error formatting
        const msg =
          e?.response?.data?.message ||
          e?.response?.statusText ||
          e?.message ||
          "Woo request failed";
        return res.json({ type: "tool_error", error: msg });
      }
    }

    return res.json({ type: "tool_error", error: `Unknown tool: ${name}` });
  }

  // Méthode non reconnue
  return res.json({ type: "tool_error", error: "Unknown method" });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ MCP server running on port ${PORT}`);
});
