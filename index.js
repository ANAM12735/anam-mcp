// === index.js — Version complète et corrigée ===

// Import des modules
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// Création de l’app Express
const app = express();
app.use(express.json());

// --- Vérification de la config ---
app.get("/", (req, res) => {
  res.send("✅ Serveur MCP en ligne et fonctionnel !");
});

app.get("/debug-auth", (req, res) => {
  res.json({
    MCP_TOKEN_defined: !!process.env.MCP_TOKEN,
    MCP_TOKEN: process.env.MCP_TOKEN ? "✔️ défini" : "❌ manquant",
  });
});

// --- Fonction utilitaire pour WooCommerce ---
async function fetchFromWoo(endpoint) {
  const url = `${process.env.WC_URL}/wp-json/wc/v3${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        process.env.WC_KEY + ":" + process.env.WC_SECRET
      ).toString("base64")}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Erreur WooCommerce ${response.status} : ${text}`);
  }

  return response.json();
}

// === ROUTE PRINCIPALE /mcp ===
app.post("/mcp", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];

    if (!authHeader || authHeader !== `Bearer ${process.env.MCP_TOKEN}`) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const { method, params } = req.body;

    // Vérification du format
    if (!method || !params) {
      return res.status(400).json({ error: "Requête mal formée" });
    }

    // Liste des outils disponibles
    if (method === "tools.list") {
      return res.json({
        tools: [
          {
            name: "getOrders",
            description: "Récupère les commandes WooCommerce",
            input_schema: {
              type: "object",
              properties: {
                status: { type: "string" },
                per_page: { type: "number" },
              },
            },
          },
        ],
      });
    }

    // Appel réel à WooCommerce
    if (method === "tools.call") {
      if (params.name === "getOrders") {
        const { status = "completed,processing", per_page = 10 } =
          params.arguments || {};

        const commandes = await fetchFromWoo(
          `/orders?status=${status}&per_page=${per_page}`
        );

        return res.json({ commandes });
      } else {
        return res.status(400).json({ error: "Outil inconnu" });
      }
    }

    res.status(400).json({ error: "Méthode inconnue" });
  } catch (err) {
    console.error("❌ Erreur MCP :", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// === Lancement du serveur ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Serveur MCP actif sur le port ${PORT}`)
);
