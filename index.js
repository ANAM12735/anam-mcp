// Middleware pour parser le JSON
app.use(express.json());

// Vérification d'autorisation sur /mcp
app.post('/mcp', async (req, res) => {
  const authHeader = req.headers.authorization;

  // Vérifie que le header Authorization est bien défini
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Non autorisé : token manquant ou mal formaté" });
  }

  const token = authHeader.split(' ')[1];
  const expectedToken = process.env.MCP_TOKEN;

  // Vérifie que le token correspond
  if (token !== expectedToken) {
    return res.status(401).json({ error: "Non autorisé : token invalide" });
  }

  const body = req.body;

  try {
    // --- tools.list ---
    if (body.method === "tools.list") {
      return res.json({
        tools: [
          {
            name: "getOrders",
            description: "Récupère les commandes WooCommerce récentes",
            parameters: {
              type: "object",
              properties: {
                status: { type: "string" },
                per_page: { type: "integer" }
              }
            }
          }
        ]
      });
    }

    // --- tools.call ---
    if (body.method === "tools.call" && body.params?.name === "getOrders") {
      const { status = "completed,processing", per_page = 5 } = body.params.arguments || {};

      // Appel à l'API WooCommerce
      const response = await fetch(`${process.env.WC_API_URL}/orders?status=${status}&per_page=${per_page}`, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`).toString('base64'),
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const text = await response.text();
        return res.status(response.status).json({ error: "Erreur WooCommerce", details: text });
      }

      const data = await response.json();
      return res.json({ orders: data });
    }

    // Si la méthode n’est pas reconnue
    return res.status(400).json({ error: "Méthode inconnue" });

  } catch (err) {
    console.error("Erreur MCP:", err);
    return res.status(500).json({ error: "Erreur interne du serveur", details: err.message });
  }
});
