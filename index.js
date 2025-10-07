import express from "express";
import fetch from "node-fetch";

/* =======================
   CONFIG (via variables d’environnement)
   ======================= */
const PORT       = process.env.PORT || 10000;
const MCP_TOKEN  = process.env.MCP_TOKEN || "";
const WC_URL     = (process.env.WC_URL || "").replace(/\/+$/, ""); // ex: https://anam-and-styles.com/wp-json/wc/v3
const WC_KEY     = process.env.WC_KEY || "";     // ck_...
const WC_SECRET  = process.env.WC_SECRET || "";  // cs_...

/* =======================
   APP
   ======================= */
const app = express();
app.use(express.json());

/* --- Health --- */
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MCP Anam", version: 2 });
});

/* --- Debug auth --- */
app.get("/debug-auth", (_req, res) => {
  res.json({
    MCP_TOKEN_defined: !!MCP_TOKEN,
    WC_URL_set: !!WC_URL,
    WC_KEY_set: !!WC_KEY,
    WC_SECRET_set: !!WC_SECRET,
  });
});

/* =======================
   Helpers WooCommerce
   ======================= */
function requireWooCreds() {
  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    const err = new Error("WooCommerce credentials not set (WC_URL, WC_KEY, WC_SECRET).");
    err.status = 500;
    throw err;
  }
}

async function wooGetJSON(pathWithQuery) {
  requireWooCreds();
  const url = `${WC_URL.replace(/\/+$/, "")}/${pathWithQuery.replace(/^\/+/, "")}`;
  const basic = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");

  const r = await fetch(url, {
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    },
    // timeouts à 20s pour éviter les plantages sur gros mois
    // NB: node-fetch v3 n'a pas 'timeout' direct – on garde simple ici.
  });

  const text = await r.text();
  if (!r.ok) {
    try {
      const j = JSON.parse(text);
      const msg = j.message || j.error || JSON.stringify(j);
      throw new Error(`Woo ${r.status}: ${msg}`);
    } catch {
      throw new Error(`Woo ${r.status}: ${text}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Réponse Woo non-JSON: " + text.slice(0, 500));
  }
}

async function wooGetRefunds(orderId) {
  return wooGetJSON(`orders/${orderId}/refunds`);
}

function monthRange(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10) - 1;
  const afterISO = new Date(Date.UTC(y, m, 1, 0, 0, 0)).toISOString();
  const beforeISO = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString();
  return { afterISO, beforeISO };
}

/* =======================
   MCP (auth Bearer)
   ======================= */
function mcpAuth(req, res, next) {
  if (!MCP_TOKEN) return res.status(500).json({ error: "MCP_TOKEN non défini côté serveur" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Authorization Bearer requis" });
  const token = auth.slice("Bearer ".length);
  if (token !== MCP_TOKEN) return res.status(403).json({ error: "Jeton invalide" });
  next();
}

/* ---- /mcp : tools.list & tools.call(getOrders) ---- */
app.post("/mcp", mcpAuth, async (req, res) => {
  try {
    const { method, params } = req.body || {};

    if (method === "tools.list") {
      return res.json({
        type: "tool_result",
        content: {
          tools: [
            {
              name: "getOrders",
              description: "Liste les commandes WooCommerce (status et per_page).",
              input_schema: {
                type: "object",
                properties: {
                  status:   { type: "string", default: "processing" },
                  per_page: { type: "number", default: 5 }
                },
                required: ["status"]
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
        const status   = String(args.status || "processing");
        const per_page = Math.min(Math.max(parseInt(args.per_page || 5, 10), 1), 50);
        const q = `orders?status=${encodeURIComponent(status)}&per_page=${per_page}`;
        const data = await wooGetJSON(q);

        const orders = (Array.isArray(data) ? data : []).map(o => ({
          id: o.id,
          number: o.number,
          total: o.total,
          currency: o.currency,
          date_created: o.date_created,
          status: o.status,
          customer: `${o.billing?.first_name || ""} ${o.billing?.last_name || ""}`.trim(),
          city: o.shipping?.city || ""
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

/* =======================
   /orders-flat  (réel encaissé + refunds)
   ======================= */
/**
 * Query:
 * - year=2025
 * - month=10
 * - statuses=completed,processing
 * - limit=500
 * - include_refunds=true|false
 * - format=excel -> CSV
 */
app.get("/orders-flat", async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getUTCFullYear(), 10);
    const month = parseInt(req.query.month || (new Date().getUTCMonth() + 1), 10);
    const statuses = String(req.query.statuses || "completed,processing")
      .split(",").map(s => s.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "500", 10), 4000));
    const includeRefunds = String(req.query.include_refunds || "true").toLowerCase() === "true";
    const wantCSV = (String(req.query.format || "json").toLowerCase() === "excel");

    requireWooCreds();
    const { afterISO, beforeISO } = monthRange(year, month);

    const rows = [];
    for (const status of statuses) {
      let page = 1;
      while (rows.length < limit) {
        const per_page = Math.min(100, limit - rows.length);
        const q = `orders?status=${encodeURIComponent(status)}&per_page=${per_page}&page=${page}&after=${encodeURIComponent(afterISO)}&before=${encodeURIComponent(beforeISO)}`;
        const data = await wooGetJSON(q);
        if (!Array.isArray(data) || data.length === 0) break;

        for (const o of data) {
          // total réellement encaissé (frais de port + taxes – remises)
          const paidTotal   = parseFloat(o.total || "0") || 0;
          const shippingTot = parseFloat(o.shipping_total || "0") || 0;
          const discountTot = Math.abs(parseFloat(o.discount_total || "0") || 0);
          const taxTot      = parseFloat(o.total_tax || "0") || 0;

          // Ligne Payé
          rows.push({
            date: (o.date_created || "").replace("T"," ").replace("Z",""),
            reference: o.number,
            nom: (o.billing?.last_name || "").toString().trim(),
            prenom: (o.billing?.first_name || "").toString().trim(),
            nature: "Payé",
            moyen_paiement: o.payment_method_title || o.payment_method || "",
            montant: paidTotal,
            currency: o.currency || "EUR",
            status: o.status || "",
            ville: o.billing?.city || o.shipping?.city || "",
            shipping_total: shippingTot,
            discount_total: discountTot,
            tax_total: taxTot
          });

          // Lignes Remboursé si demandé
          if (includeRefunds) {
            const refunds = await wooGetRefunds(o.id);
            if (Array.isArray(refunds) && refunds.length > 0) {
              for (const r of refunds) {
                const refundAmount = Math.abs(parseFloat(r.amount || "0") || 0);
                rows.push({
                  date: (r.date_created || o.date_created || "").replace("T"," ").replace("Z",""),
                  reference: `${o.number}-R${r.id}`,
                  nom: (o.billing?.last_name || "").toString().trim(),
                  prenom: (o.billing?.first_name || "").toString().trim(),
                  nature: "Remboursé",
                  moyen_paiement: o.payment_method_title || o.payment_method || "",
                  montant: -refundAmount,
                  currency: o.currency || "EUR",
                  status: "refunded",
                  ville: o.billing?.city || o.shipping?.city || "",
                  shipping_total: 0,
                  discount_total: 0,
                  tax_total: 0
                });
              }
            }
          }

          if (rows.length >= limit) break;
        }

        if (data.length < per_page || rows.length >= limit) break;
        page++;
      }
      if (rows.length >= limit) break;
    }

    const payload = {
      ok: true,
      year, month, statuses, include_refunds: includeRefunds,
      count: rows.length,
      rows
    };

    if (!wantCSV) return res.json(payload);

    // ---- CSV (Excel) ----
    const headers = [
      "date","reference","nom","prenom","nature","moyen_paiement","montant","currency","ville","status",
      "shipping_total","discount_total","tax_total"
    ];
    const csv = [
      headers.join(";"),
      ...rows.map(r =>
        headers.map(h => {
          const v = r[h] ?? "";
          const s = (typeof v === "number") ? String(v).replace(".", ",") : String(v).replaceAll('"', '""');
          return `"${s}"`;
        }).join(";")
      )
    ].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders_${year}-${String(month).padStart(2,"0")}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error("orders-flat ERROR:", e);
    res.status(e.status || 500).json({ ok:false, error: e?.message || "Server error" });
  }
});

/* =======================
   /accounting-dashboard (UI)
   ======================= */
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>Comptabilité — MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f8fafc;color:#334155;line-height:1.6;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(15,23,42,.06);padding:20px;margin:0 auto 20px;max-width:1100px}
  h1{margin:0 0 6px;color:#0f172a}
  .subtitle{color:#64748b;margin-bottom:16px}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  label{display:block;font-weight:600;margin-bottom:6px;color:#475569}
  select,input{width:100%;padding:10px 12px;border:2px solid #e2e8f0;border-radius:10px;font-size:15px}
  select:focus,input:focus{outline:none;border-color:#3b82f6}
  .quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
  .m{border:2px solid #e2e8f0;background:#fff;border-radius:10px;padding:10px 14px;cursor:pointer}
  .m:hover{border-color:#3b82f6;background:#eff6ff}
  .m.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .btn{border:none;border-radius:10px;padding:10px 16px;cursor:pointer;font-weight:700}
  .btn-primary{background:#10b981;color:#fff}.btn-primary:hover{background:#059669}
  .btn-blue{background:#3b82f6;color:#fff}.btn-blue:hover{background:#2563eb}
  .btn-out{background:#fff;border:2px solid #e2e8f0;color:#334155}
  .stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  .stat{background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(15,23,42,.06);padding:18px;text-align:center}
  .v{font-size:28px;font-weight:800;color:#0f172a}
  .t{color:#64748b}
  table{width:100%;border-collapse:collapse}
  th,td{padding:12px;border-bottom:1px solid #eef2f7}
  th{background:#f8fafc;text-align:left;color:#475569}
  tr:hover{background:#f8fafc}
  .pos{color:#10b981;font-weight:700}
  .neg{color:#ef4444;font-weight:700;background:#fef2f2}
  .loading{padding:26px;text-align:center;color:#64748b}
  .wrap{max-width:1100px;margin:0 auto}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>📊 Tableau de bord comptable</h1>
    <div class="subtitle">Total réellement encaissé = <b>order.total</b> (port & taxes inclus, remises déduites) – remboursements</div>
    <div class="grid">
      <div><label>Année</label><select id="year">
        <option>2023</option><option>2024</option><option selected>2025</option></select></div>
      <div><label>Mois</label><select id="month">
        <option value="1">Janvier</option><option value="2">Février</option><option value="3">Mars</option><option value="4">Avril</option>
        <option value="5">Mai</option><option value="6">Juin</option><option value="7">Juillet</option><option value="8">Août</option>
        <option value="9">Septembre</option><option value="10" selected>Octobre</option><option value="11">Novembre</option><option value="12">Décembre</option>
      </select></div>
      <div><label>Statuts</label><select id="statuses">
        <option value="completed">Terminées</option>
        <option value="completed,processing" selected>Terminées + En traitement</option>
        <option value="completed,processing,pending">Toutes</option>
      </select></div>
      <div><label>Limite</label><input id="limit" type="number" min="1" max="4000" value="100"/></div>
    </div>
    <div class="quick" id="quick"></div>
    <div class="actions">
      <button class="btn btn-primary" onclick="loadData()">📥 Charger les données</button>
      <button class="btn btn-blue" onclick="exportCSV()">📊 Exporter Excel</button>
      <button class="btn btn-out" onclick="resetFilters()">🔄 Réinitialiser</button>
      <a class="btn btn-out" href="/debug-auth" target="_blank">🔧 Debug API</a>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="v" id="nCmd">-</div><div class="t">Commandes</div></div>
    <div class="stat"><div class="v" id="ca">-</div><div class="t">Chiffre d'affaires</div></div>
    <div class="stat"><div class="v" id="remb">-</div><div class="t">Remboursements</div></div>
    <div class="stat"><div class="v" id="net">-</div><div class="t">Revenu net</div></div>
  </div>

  <div class="card">
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Date</th><th>Référence</th><th>Client</th><th>Nature</th>
          <th>Moyen paiement</th><th>Montant</th><th>Ville</th><th>Statut</th>
        </tr></thead>
        <tbody id="tbody">
          <tr><td colspan="8" class="loading">⏳ Prêt à charger…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
const months = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const ySel = document.getElementById('year');
const mSel = document.getElementById('month');
const sSel = document.getElementById('statuses');
const lInp = document.getElementById('limit');
const tbody= document.getElementById('tbody');

function euros(n){return (Number(n)||0).toFixed(2).replace('.',',')+' €';}

function makeQuick(){
  const q = document.getElementById('quick');
  months.forEach((m,i)=>{
    const b=document.createElement('button');b.className='m';b.textContent=m;
    b.onclick=()=>{document.querySelectorAll('.m').forEach(x=>x.classList.remove('active'));b.classList.add('active');mSel.value=String(i+1);loadData();}
    if((i+1)===(new Date().getUTCMonth()+1)) b.classList.add('active');
    q.appendChild(b);
  });
}

async function loadData(){
  tbody.innerHTML='<tr><td colspan="8" class="loading">⏳ Chargement…</td></tr>';
  try{
    const url=\`/orders-flat?year=\${ySel.value}&month=\${mSel.value}&statuses=\${sSel.value}&limit=\${lInp.value}&include_refunds=true\`;
    const r=await fetch(url); const data=await r.json();
    if(!data.ok) throw new Error(data.error||'Erreur');
    render(data);
  }catch(e){
    tbody.innerHTML=\`<tr><td colspan="8" class="loading" style="color:#ef4444">❌ \${e.message}</td></tr>\`;
    setStats('-','-','-','-');
  }
}

function render(data){
  const rows=data.rows||[];
  if(!rows.length){tbody.innerHTML='<tr><td colspan="8" class="loading">📭 Aucune donnée</td></tr>';setStats(0,'0 €','0 €','0 €');return;}
  tbody.innerHTML = rows.map(r=>\`
    <tr class="\${r.nature==='Remboursé'?'neg':''}">
      <td>\${r.date}</td>
      <td><b>\${r.reference}</b></td>
      <td>\${r.prenom} \${r.nom}</td>
      <td>\${r.nature}</td>
      <td>\${r.moyen_paiement}</td>
      <td class="\${r.montant>=0?'pos':'neg'}">\${euros(r.montant)}</td>
      <td>\${r.ville||''}</td>
      <td>\${r.status||''}</td>
    </tr>\`).join('');

  const payes = rows.filter(r=>r.nature==='Payé').reduce((s,r)=>s+(Number(r.montant)||0),0);
  const refunds = rows.filter(r=>r.nature==='Remboursé').reduce((s,r)=>s+(Number(r.montant)||0),0); // négatif
  const net = payes + refunds;

  setStats(rows.filter(r=>r.nature==='Payé').length, euros(payes), euros(Math.abs(refunds)), euros(net));
}

function setStats(n,ca,rb,net){
  document.getElementById('nCmd').textContent=n;
  document.getElementById('ca').textContent=ca;
  document.getElementById('remb').textContent=rb;
  document.getElementById('net').textContent=net;
}

function exportCSV(){
  const url=\`/orders-flat?year=\${ySel.value}&month=\${mSel.value}&statuses=\${sSel.value}&limit=\${lInp.value}&include_refunds=true&format=excel\`;
  window.open(url,'_blank');
}

function resetFilters(){
  const now=new Date(); ySel.value=String(now.getUTCFullYear()); mSel.value=String(now.getUTCMonth()+1);
  sSel.value='completed,processing'; lInp.value='100';
  document.querySelectorAll('.m').forEach((b,i)=>b.classList.toggle('active', i===now.getUTCMonth()));
  loadData();
}

document.addEventListener('DOMContentLoaded', ()=>{
  // année courante
  const now=new Date(); ySel.value=String(now.getUTCFullYear()); mSel.value=String(now.getUTCMonth()+1);
  makeQuick();
  setTimeout(loadData, 400);
});
</script>
</body></html>`);
});

/* =======================
   START
   ======================= */
app.listen(PORT, () => {
  console.log(`✅ MCP server listening on :${PORT}`);
});
