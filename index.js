import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Vérification du token dans les requêtes
function checkAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const expected = process.env.MCP_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: "MCP_TOKEN non défini côté serveur" });
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Jeton manquant ou mal formé" });
  }
  const token = authHeader.split(" ")[1];
  if (token !== expected) {
    return res.status(403).json({ error: "Jeton invalide" });
  }
  next();
}

// Route principale MCP
app.post("/mcp", checkAuth, async (req, res) => {
  try {
    const { method, params } = req.body;

    if (method !== "tools.call" || !params?.name) {
      return res.status(400).json({ error: "Requête MCP invalide" });
    }

    if (params.name === "getOrders") {
      const { status, per_page } = params.arguments || {};

      // ✅ Remplace ICI par ton domaine WooCommerce et clé API
      const wooUrl = `https://anamandstyles.com/wp-json/wc/v3/orders?status=${status}&per_page=${per_page}`;
      const wooRes = await fetch(wooUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(
            process.env.WOO_KEY + ":" + process.env.WOO_SECRET
          ).toString("base64")}`,
        },
      });

      if (!wooRes.ok) {
        const text = await wooRes.text();
        return res.status(wooRes.status).json({ error: text });
      }

      const data = await wooRes.json();
      return res.json({ success: true, count: data.length, orders: data });
    }

    return res.status(400).json({ error: "Outil inconnu" });
  } catch (err) {
    console.error("Erreur MCP :", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// Vérification token pour debug
app.get("/debug-auth", (req, res) => {
  res.json({ MCP_TOKEN_defined: !!process.env.MCP_TOKEN });
});

app.listen(PORT, () => {
  console.log(`✅ Serveur MCP actif sur le port ${PORT}`);
});
