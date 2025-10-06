app.get("/orders-flat", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);
    const month = parseInt(req.query.month || (new Date().getUTCMonth() + 1), 10);
    const statuses = String(req.query.statuses || "completed,processing")
      .split(",").map(s => s.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 1000));
    const includeRefunds = String(req.query.include_refunds || "true").toLowerCase() === "true";

    // Vérification credentials Woo
    if (!WC_URL || !WC_KEY || !WC_SECRET) {
      throw new Error("Configuration WooCommerce manquante");
    }

    // Calcul des dates
    const y = parseInt(year, 10);
    const m = parseInt(month, 10) - 1;
    const afterISO = new Date(Date.UTC(y, m, 1, 0, 0, 0)).toISOString();
    const beforeISO = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString();

    const basicAuth = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
    const rows = [];

    // Récupération des commandes
    for (const status of statuses) {
      let page = 1;
      let hasMore = true;

      while (hasMore && rows.length < limit) {
        const per_page = Math.min(100, limit - rows.length);
        const wooUrl = `${WC_URL}/orders?status=${status}&per_page=${per_page}&page=${page}&after=${afterISO}&before=${beforeISO}`;
        
        const response = await fetch(wooUrl, {
          headers: {
            Authorization: `Basic ${basicAuth}`,
            Accept: "application/json",
            "User-Agent": "anam-mcp/1.0"
          }
        });

        if (!response.ok) {
          throw new Error(`WooCommerce ${response.status}: ${await response.text()}`);
        }

        const orders = await response.json();
        
        if (!Array.isArray(orders) || orders.length === 0) {
          hasMore = false;
          break;
        }

        // Traitement des commandes
        for (const order of orders) {
          // Ligne commande
          rows.push({
            date: (order.date_created || "").replace("T", " ").replace("Z", ""),
            reference: order.number,
            nom: (order.billing?.last_name || "").toString().trim(),
            prenom: (order.billing?.first_name || "").toString().trim(),
            nature: "Payé",
            moyen_paiement: order.payment_method_title || order.payment_method || "",
            montant: parseFloat(order.total || "0") || 0,
            currency: order.currency || "EUR",
            status: order.status,
            ville: order.billing?.city || order.shipping?.city || ""
          });

          // Remboursements si demandés
          if (includeRefunds) {
            try {
              const refundsUrl = `${WC_URL}/orders/${order.id}/refunds`;
              const refundsResponse = await fetch(refundsUrl, {
                headers: {
                  Authorization: `Basic ${basicAuth}`,
                  Accept: "application/json"
                }
              });

              if (refundsResponse.ok) {
                const refunds = await refundsResponse.json();
                if (Array.isArray(refunds)) {
                  for (const refund of refunds) {
                    rows.push({
                      date: (refund.date_created || order.date_created || "").replace("T", " ").replace("Z", ""),
                      reference: `${order.number}-R${refund.id}`,
                      nom: (order.billing?.last_name || "").toString().trim(),
                      prenom: (order.billing?.first_name || "").toString().trim(),
                      nature: "Remboursé",
                      moyen_paiement: order.payment_method_title || order.payment_method || "",
                      montant: -Math.abs(parseFloat(refund.amount || "0") || 0),
                      currency: order.currency || "EUR",
                      status: "refunded",
                      ville: order.billing?.city || order.shipping?.city || ""
                    });
                  }
                }
              }
            } catch (refundError) {
              console.error("Erreur remboursements:", refundError);
              // On continue même si les remboursements échouent
            }
          }

          if (rows.length >= limit) break;
        }

        if (orders.length < per_page) hasMore = false;
        page++;
      }
    }

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
    console.error("orders-flat ERROR:", error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      details: "Erreur de connexion WooCommerce"
    });
  }
});
