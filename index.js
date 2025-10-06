// index.js
import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const PORT      = process.env.PORT || 10000;
const WC_URL    = process.env.WC_URL    || ""; // ex: https://tonsite.com/wp-json/wc/v3/
const WC_KEY    = process.env.WC_KEY    || ""; // ck_...
const WC_SECRET = process.env.WC_SECRET || ""; // cs_...
const MCP_TOKEN = process.env.MCP_TOKEN || "";

// --- Santé
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam & Styles" });
});

// --- Debug auth (ne montre pas la valeur)
app.get("/debug-auth", (_req, res) => {
  res.json({ MCP_TOKEN_defined: Boolean(MCP_TOKEN) });
});

// --- Auth globale (sauf pages publiques)
const PUBLIC_PATHS = new Set(["/", "/debug-auth"]);
app.use((req, res, next) => {
  if (!MCP_TOKEN) return next(); // pas d'auth requise si pas de token
  if (PUBLIC_PATHS.has(req.path)) return next();

  const header = req.headers.authorization || "";
  const queryToken = req.query.token ? `Bearer ${req.query.token}` : "";
  if (header === `Bearer ${MCP_TOKEN}` || queryToken === `Bearer ${MCP_TOKEN}`) {
    return next();
  }
  return res.status(401).json({ error: "Non autorisé" });
});

// --- Utilitaires Woo
function woo() {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    throw new Error("WooCommerce credentials not set (WC_URL, WC_KEY, WC_SECRET)");
  }
  return axios.create({
    baseURL: WC_URL,
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 20000,
  });
}

async function fetchOrdersPaged({ statuses, afterISO, beforeISO, limit = 500 }) {
  const client = woo();
  const results = [];
  const per_page = 100; // max Woo
  let page = 1;

  while (true) {
    const url = `/orders`;
    const { data, headers } = await client.get(url, {
      params: {
        status: statuses,            // "completed,processing" (CSV)
        per_page,
        page,
        after: afterISO,             // ISO 8601
        before: beforeISO,           // ISO 8601
        orderby: "date",
        order: "asc",
      }
    });

    const arr = Array.isArray(data) ? data : [];
    results.push(...arr);

    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    const reachedLimit = results.length >= limit;
    if (page >= totalPages || reachedLimit) break;
    page++;
  }

  // Tronque si on a dépassé le limit
  return results.slice(0, limit);
}

async function fetchRefundsForOrder(orderId) {
  const client = woo();
  const { data } = await client.get(`/orders/${orderId}/refunds`);
  return Array.isArray(data) ? data : [];
}

// Mapping de status Woo -> “Nature” Excel
function statusToNature(status) {
  // valeurs Excel vues: "Terminée", "Remboursée", "Annulée"
  if (status === "refunded") return "Remboursée";
  if (status === "cancelled" || status === "failed") return "Annulée";
  // pour "completed", "processing", "on-hold", "pending", etc.
  return "Terminée";
}

// --- /orders-flat : liste à plat (format Excel)
app.get("/orders-flat", async (req, res) => {
  try {
    // Paramètres
    const year     = parseInt(req.query.year || new Date().getFullYear(), 10);
    const month    = parseInt(req.query.month || (new Date().getMonth() + 1), 10); // 1..12
    const statuses = (req.query.statuses || "completed,processing").toString();    // CSV
    const limit    = Math.min(parseInt(req.query.limit || "500", 10), 2000);       // garde-fou
    const includeRefunds = (req.query.include_refunds || "true").toString() !== "false";

    // bornes temporelles mois
    const afterISO  = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
    const beforeISO = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();

    const orders = await fetchOrdersPaged({ statuses, afterISO, beforeISO, limit });

    // Aplatissement
    const rows = [];

    for (const o of orders) {
      const total = parseFloat(o.total || "0") || 0;
      const first = o.billing?.first_name || "";
      const last  = o.billing?.last_name  || "";
      const full  = `${first} ${last}`.trim();

      // Enregistrer la ligne “paiement” (commande)
      rows.push({
        date: (o.date_created || "").replace("T", " ").replace("Z", ""),
        order_id: o.id,
        reference: o.number,
        first_name: first,
        last_name: last,
        customer: full,
        nature: statusToNature(o.status),         // Terminée / Annulée / (refunded géré plus bas)
        payment_method: o.payment_method_title || o.payment_method || "",
        amount: +total,                            // positif
        currency: o.currency || "EUR",
        city: o.shipping?.city || o.billing?.city || "",
        status: o.status
      });

      // Enregistrer les remboursements si demandé
      if (includeRefunds) {
        const refunds = await fetchRefundsForOrder(o.id);
        for (const r of refunds) {
          const amt = Math.abs(parseFloat(r.amount || "0")) || 0;
          rows.push({
            date: (r.date_created || o.date_created || "").replace("T", " ").replace("Z", ""),
            order_id: o.id,
            reference: o.number,
            first_name: first,
            last_name: last,
            customer: full,
            nature: "Remboursée",
            payment_method: o.payment_method_title || o.payment_method || "",
            amount: -amt,                           // négatif
            currency: o.currency || "EUR",
            city: o.shipping?.city || o.billing?.city || "",
            status: "refunded"
          });
        }
      }
    }

    res.json({ ok: true, year, month, statuses, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data?.message || e.message || "Failed" });
  }
});

// --- Démarrage
app.listen(PORT, () => {
  console.log(`✅ MCP server running on port ${PORT}`);
});
