// -------- Utils compta --------

// petite pause
const sleep = ms => new Promise(r => setTimeout(r, ms));

// limiteur de concurrence simple (pour les refunds)
async function mapLimit(arr, limit, worker) {
  const out = [];
  let i = 0, active = 0, reject;
  return await new Promise((resolve, rej) => {
    reject = rej;
    (function next() {
      if (i === arr.length && active === 0) return resolve(out);
      while (active < limit && i < arr.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(arr[idx], idx))
          .then(v => out[idx] = v)
          .catch(reject)
          .finally(() => { active--; next(); });
      }
    })();
  });
}

// clé mois "YYYY-MM"
function monthKey(dateStr) {
  return (dateStr || "").slice(0, 7);
}

// Paginer /orders côté Woo (with _fields pour réduire la charge)
async function fetchOrdersPaged({ status, afterISO, beforeISO, perPage = 100, pageLimit = 100 }) {
  const results = [];
  let page = 1;
  const fields = "_fields=id,total,date_created,refunds";

  while (page <= pageLimit) {
    const url = `${WC_URL}orders?status=${encodeURIComponent(status)}`
      + `&per_page=${perPage}&page=${page}`
      + `&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`
      + `&${fields}`;

    const { data, headers } = await axios.get(url, {
      auth: { username: WC_KEY, password: WC_SECRET },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 300
    });

    results.push(...data);
    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

// Récupérer les refunds d'une commande (seulement si nécessaire)
async function fetchRefundsForOrder(orderId) {
  const url = `${WC_URL}orders/${orderId}/refunds?_fields=id,amount,date_created`;
  const { data } = await axios.get(url, {
    auth: { username: WC_KEY, password: WC_SECRET },
    timeout: 15000,
  });
  return Array.isArray(data) ? data : [];
}

// -------- API Comptabilité (optimisée) --------
// Params ajoutés :
// - month=YYYY-MM (facultatif) : limite à un mois précis
// - preview=N (facultatif) : limite aux N dernières commandes par statut
// - refunds_concurrency=5 (facultatif) : plafonne les appels /refunds
app.get("/accounting", async (req, res) => {
  try {
    const yearParam = (req.query.year || new Date().getFullYear()).toString();
    const monthParam = req.query.month || null;           // ex: 2025-10
    const statuses = (req.query.statuses || "completed,processing")
      .split(",").map(s => s.trim()).filter(Boolean);
    const preview = parseInt(req.query.preview || "0", 10); // 0 = illimité
    const refundsConcurrency = Math.min(
      Math.max(parseInt(req.query.refunds_concurrency || "5", 10), 1),
      10
    );

    if (!WC_URL || !WC_KEY || !WC_SECRET) {
      return res.status(500).json({ ok: false, error: "WooCommerce credentials not set" });
    }

    // Fenêtre temporelle (année complète ou mois unique)
    let start, end;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [y, m] = monthParam.split("-").map(Number);
      start = new Date(Date.UTC(y, m - 1, 1));
      end   = new Date(Date.UTC(y, m, 1));
    } else {
      const year = parseInt(yearParam, 10);
      start = new Date(Date.UTC(year, 0, 1));
      end   = new Date(Date.UTC(year + 1, 0, 1));
    }
    const afterISO  = start.toISOString();
    const beforeISO = end.toISOString();

    // Préparer tous les buckets mensuels concernés
    const months = {};
    const startYear = start.getUTCFullYear();
    const endYear   = end.getUTCFullYear();
    for (let y = startYear; y <= endYear; y++) {
      const firstM = (y === startYear) ? start.getUTCMonth() : 0;
      const lastM  = (y === endYear)   ? Math.max(0, end.getUTCMonth() - 1) : 11;
      for (let m = firstM; m <= lastM; m++) {
        const key = `${y}-${String(m + 1).padStart(2, "0")}`;
        months[key] = { month: key, orders_count: 0, gross_sales: 0, refunds_count: 0, refunds_total: 0, net_revenue: 0 };
      }
    }

    // 1) Ventes (par statut) — triées par date + preview éventuel
    let allOrders = [];
    for (const status of statuses) {
      let orders = await fetchOrdersPaged({ status, afterISO, beforeISO, perPage: 100, pageLimit: 50 });
      orders.sort((a, b) => new Date(a.date_created) - new Date(b.date_created));
      if (preview > 0) orders = orders.slice(-preview); // ne garder que les N dernières
      allOrders.push(...orders);

      for (const o of orders) {
        const key = monthKey(o.date_created);
        const total = parseFloat(o.total || "0") || 0;
        if (months[key]) {
          months[key].orders_count++;
          months[key].gross_sales += total;
        }
      }
    }

    // 2) Refunds — on limite la charge : concurrence plafonnée + preview si demandé
    const refundCandidates = (preview > 0) ? allOrders.slice(-preview) : allOrders;

    const refundsResults = await mapLimit(refundCandidates, refundsConcurrency, async (o) => {
      // si Woo indique refunds=[] → skip
      if (Array.isArray(o.refunds) && o.refunds.length === 0) return [];
      try {
        return await fetchRefundsForOrder(o.id);
      } catch {
        await sleep(300);
        return [];
      }
    });

    refundsResults.forEach((refunds, idx) => {
      const order = refundCandidates[idx];
      refunds.forEach(r => {
        const key = monthKey(r.date_created || order.date_created);
        const amt = Math.abs(parseFloat(r.amount || "0")) || 0;
        if (months[key]) {
          months[key].refunds_count++;
          months[key].refunds_total += amt;
        }
      });
    });

    // 3) Totaux
    for (const k of Object.keys(months)) {
      const m = months[k];
      m.gross_sales   = +m.gross_sales.toFixed(2);
      m.refunds_total = +m.refunds_total.toFixed(2);
      m.net_revenue   = +(m.gross_sales - m.refunds_total).toFixed(2);
    }

    return res.json({
      ok: true,
      window: { afterISO, beforeISO, month: monthParam || null },
      statuses,
      preview,
      refunds_concurrency: refundsConcurrency,
      months: Object.values(months)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Accounting failed" });
  }
});
