import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// Route de santé BASIQUE
app.get("/", (req, res) => {
  res.json({ 
    ok: true, 
    service: "MCP Anam", 
    timestamp: new Date().toISOString(),
    message: "✅ Service en ligne"
  });
});

// Route debug SIMPLE
app.get("/debug-auth", (req, res) => {
  res.json({
    MCP_TOKEN: !!process.env.MCP_TOKEN,
    WC_URL: !!process.env.WC_URL,
    WC_KEY: !!process.env.WC_KEY,
    WC_SECRET: !!process.env.WC_SECRET,
    timestamp: new Date().toISOString()
  });
});

// MCP endpoint SIMPLIFIÉ
app.post("/mcp", (req, res) => {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token manquant" });
  }
  
  const token = auth.slice(7);
  if (token !== process.env.MCP_TOKEN) {
    return res.status(403).json({ error: "Token invalide" });
  }

  // Réponse FIXE pour tester
  res.json({
    type: "tool_result",
    content: {
      tools: [
        {
          name: "getOrders",
          description: "Liste les commandes WooCommerce",
          input_schema: {
            type: "object",
            properties: {
              status: { type: "string", default: "processing" },
              per_page: { type: "number", default: 5 }
            }
          }
        }
      ]
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 MCP Server started on port ${PORT}`);
  console.log(`📅 ${new Date().toISOString()}`);
});
