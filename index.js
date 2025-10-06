// Petite interface web pour la comptabilité
app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<meta charset="utf-8" />
<title>Comptabilité — MCP</title>
<style>
  body { font-family: system-ui, Arial; background: #fafafa; margin: 0; padding: 24px; }
  h1 { color: #333; }
  button { 
    margin: 4px; padding: 8px 14px; border: none; border-radius: 6px;
    background: #007bff; color: white; cursor: pointer; font-size: 15px;
  }
  button:hover { background: #0056b3; }
  #output { margin-top: 20px; white-space: pre; background: #fff; padding: 16px; border-radius: 6px; box-shadow: 0 0 4px rgba(0,0,0,0.1); }
</style>
<body>
  <h1>📊 Comptabilité — MCP OK ✅</h1>
  <p>Choisissez un mois pour afficher les commandes WooCommerce :</p>
  <div id="buttons"></div>
  <div id="output">Sélectionnez un mois ci-dessus...</div>

<script>
const months = [
  "Janvier","Février","Mars","Avril","Mai","Juin",
  "Juillet","Août","Septembre","Octobre","Novembre","Décembre"
];
const now = new Date();
const currentYear = now.getUTCFullYear();
const buttonsDiv = document.getElementById("buttons");
const output = document.getElementById("output");

months.forEach((m, i) => {
  const btn = document.createElement("button");
  btn.textContent = m;
  btn.onclick = async () => {
    output.textContent = "Chargement des commandes...";
    const month = i + 1;
    const url = \`/orders-flat?year=\${currentYear}&month=\${month}&statuses=completed,processing&limit=100&include_refunds=true\`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Erreur");
      output.textContent = "✅ " + data.count + " commandes trouvées\\n\\n" +
        data.rows.map(r => \`\${r.date} | \${r.reference} | \${r.nom} \${r.prenom} | \${r.nature} | \${r.montant}€ | \${r.status}\`).join("\\n");
    } catch(e) {
      output.textContent = "❌ Erreur : " + e.message;
    }
  };
  buttonsDiv.appendChild(btn);
});
</script>
</body>
</html>`);
});
