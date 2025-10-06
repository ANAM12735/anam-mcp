app.get("/accounting-dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>Comptabilité — MCP</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { 
    font-family: system-ui, -apple-system, sans-serif; 
    background: #f8fafc; 
    color: #334155;
    line-height: 1.6;
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }
  
  .header { 
    background: white;
    padding: 2rem;
    border-radius: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    margin-bottom: 2rem;
    text-align: center;
  }
  
  h1 { 
    color: #1e293b; 
    margin-bottom: 0.5rem;
    font-size: 2.5rem;
  }
  
  .subtitle {
    color: #64748b;
    font-size: 1.1rem;
  }
  
  .controls {
    background: white;
    padding: 1.5rem;
    border-radius: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    margin-bottom: 2rem;
  }
  
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  
  .filter-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: #475569;
  }
  
  select, input {
    width: 100%;
    padding: 0.75rem;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    font-size: 1rem;
    transition: border-color 0.2s;
  }
  
  select:focus, input:focus {
    outline: none;
    border-color: #3b82f6;
  }
  
  .quick-months {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }
  
  .month-btn {
    padding: 0.75rem 1.5rem;
    border: 2px solid #e2e8f0;
    background: white;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
  }
  
  .month-btn:hover {
    border-color: #3b82f6;
    background: #f0f7ff;
  }
  
  .month-btn.active {
    background: #3b82f6;
    color: white;
    border-color: #3b82f6;
  }
  
  .actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  
  .btn {
    padding: 0.875rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .btn-primary {
    background: #10b981;
    color: white;
  }
  
  .btn-primary:hover {
    background: #059669;
  }
  
  .btn-secondary {
    background: #3b82f6;
    color: white;
  }
  
  .btn-secondary:hover {
    background: #2563eb;
  }
  
  .btn-outline {
    background: white;
    color: #475569;
    border: 2px solid #e2e8f0;
  }
  
  .btn-outline:hover {
    border-color: #94a3b8;
  }
  
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  
  .stat-card {
    background: white;
    padding: 1.5rem;
    border-radius: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    text-align: center;
  }
  
  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 0.5rem;
  }
  
  .stat-label {
    color: #64748b;
    font-size: 0.9rem;
  }
  
  .results {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    overflow: hidden;
  }
  
  .table-container {
    overflow-x: auto;
  }
  
  table {
    width: 100%;
    border-collapse: collapse;
  }
  
  th {
    background: #f8fafc;
    padding: 1rem;
    text-align: left;
    font-weight: 600;
    color: #475569;
    border-bottom: 2px solid #e2e8f0;
  }
  
  td {
    padding: 1rem;
    border-bottom: 1px solid #f1f5f9;
  }
  
  tr:hover {
    background: #f8fafc;
  }
  
  .positive { color: #10b981; font-weight: 600; }
  .negative { color: #ef4444; font-weight: 600; }
  .refund { background: #fef2f2; }
  
  .loading {
    text-align: center;
    padding: 3rem;
    color: #64748b;
  }
  
  .error {
    background: #fef2f2;
    color: #dc2626;
    padding: 1rem;
    border-radius: 8px;
    margin: 1rem 0;
  }
  
  .success {
    background: #f0fdf4;
    color: #16a34a;
    padding: 1rem;
    border-radius: 8px;
    margin: 1rem 0;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>📊 Tableau de Bord Comptable</h1>
    <p class="subtitle">Données WooCommerce en temps réel • MCP Anam</p>
  </div>

  <div class="controls">
    <div class="filters">
      <div class="filter-group">
        <label>Année</label>
        <select id="yearSelect">
          <option value="2025">2025</option>
          <option value="2024">2024</option>
          <option value="2023">2023</option>
        </select>
      </div>
      
      <div class="filter-group">
        <label>Mois</label>
        <select id="monthSelect">
          <option value="1">Janvier</option>
          <option value="2">Février</option>
          <option value="3">Mars</option>
          <option value="4">Avril</option>
          <option value="5">Mai</option>
          <option value="6">Juin</option>
          <option value="7">Juillet</option>
          <option value="8">Août</option>
          <option value="9">Septembre</option>
          <option value="10" selected>Octobre</option>
          <option value="11">Novembre</option>
          <option value="12">Décembre</option>
        </select>
      </div>
      
      <div class="filter-group">
        <label>Statuts</label>
        <select id="statusSelect">
          <option value="completed">Terminées seulement</option>
          <option value="completed,processing" selected>Terminées + En traitement</option>
          <option value="completed,processing,pending">Toutes les statuts</option>
        </select>
      </div>
      
      <div class="filter-group">
        <label>Limite</label>
        <input type="number" id="limitInput" value="100" min="1" max="1000">
      </div>
    </div>

    <div class="quick-months" id="quickMonths">
      <!-- Les boutons mois seront générés par JavaScript -->
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="loadData()">
        📥 Charger les données
      </button>
      <button class="btn btn-secondary" onclick="exportExcel()">
        📊 Exporter Excel
      </button>
      <button class="btn btn-outline" onclick="resetFilters()">
        🔄 Réinitialiser
      </button>
      <a href="/debug-auth" class="btn btn-outline" target="_blank">
        🔧 Debug API
      </a>
    </div>
  </div>

  <div class="stats" id="statsContainer">
    <div class="stat-card">
      <div class="stat-value" id="totalOrders">-</div>
      <div class="stat-label">Commandes</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="totalRevenue">-</div>
      <div class="stat-label">Chiffre d'affaires</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="totalRefunds">-</div>
      <div class="stat-label">Remboursements</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="netRevenue">-</div>
      <div class="stat-label">Revenu net</div>
    </div>
  </div>

  <div class="results">
    <div class="table-container">
      <table id="resultsTable">
        <thead>
          <tr>
            <th>Date</th>
            <th>Référence</th>
            <th>Client</th>
            <th>Nature</th>
            <th>Moyen paiement</th>
            <th>Montant</th>
            <th>Ville</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody id="resultsBody">
          <tr>
            <td colspan="8" class="loading">
              ⏳ Sélectionnez des filtres et cliquez sur "Charger les données"
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const months = [
      "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
      "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"
    ];
    
    const currentYear = new Date().getUTCFullYear();
    const currentMonth = new Date().getUTCMonth() + 1;

    // Générer les boutons mois rapides
    function generateQuickMonths() {
      const container = document.getElementById('quickMonths');
      months.forEach((month, index) => {
        const monthNum = index + 1;
        const btn = document.createElement('button');
        btn.className = 'month-btn';
        btn.textContent = month;
        if (monthNum === currentMonth) {
          btn.classList.add('active');
        }
        btn.onclick = () => {
          document.querySelectorAll('.month-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('monthSelect').value = monthNum;
          loadData();
        };
        container.appendChild(btn);
      });
    }

    // Charger les données
    async function loadData() {
      const year = document.getElementById('yearSelect').value;
      const month = document.getElementById('monthSelect').value;
      const statuses = document.getElementById('statusSelect').value;
      const limit = document.getElementById('limitInput').value;
      
      const resultsBody = document.getElementById('resultsBody');
      resultsBody.innerHTML = '<tr><td colspan="8" class="loading">⏳ Chargement des données en cours...</td></tr>';
      
      try {
        const url = \`/orders-flat?year=\${year}&month=\${month}&statuses=\${statuses}&limit=\${limit}&include_refunds=true\`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.ok) throw new Error(data.error || 'Erreur de chargement');
        
        displayResults(data);
        updateStats(data);
        
      } catch (error) {
        resultsBody.innerHTML = \`<tr><td colspan="8" class="error">❌ Erreur: \${error.message}</td></tr>\`;
        resetStats();
      }
    }

    // Afficher les résultats
    function displayResults(data) {
      const tbody = document.getElementById('resultsBody');
      
      if (!data.rows || data.rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">📭 Aucune donnée trouvée pour cette période</td></tr>';
        return;
      }
      
      tbody.innerHTML = data.rows.map(row => \`
        <tr class="\${row.nature === 'Remboursé' ? 'refund' : ''}">
          <td>\${row.date}</td>
          <td><strong>\${row.reference}</strong></td>
          <td>\${row.prenom} \${row.nom}</td>
          <td>\${row.nature}</td>
          <td>\${row.moyen_paiement}</td>
          <td class="\${row.montant >= 0 ? 'positive' : 'negative'}">
            \${row.montant.toFixed(2)} €
          </td>
          <td>\${row.ville}</td>
          <td>\${row.status}</td>
        </tr>
      \`).join('');
    }

    // Mettre à jour les statistiques
    function updateStats(data) {
      if (!data.rows) return;
      
      const orders = data.rows.filter(r => r.nature === 'Payé');
      const refunds = data.rows.filter(r => r.nature === 'Remboursé');
      
      const totalRevenue = orders.reduce((sum, o) => sum + o.montant, 0);
      const totalRefunds = Math.abs(refunds.reduce((sum, r) => sum + r.montant, 0));
      const netRevenue = totalRevenue - totalRefunds;
      
      document.getElementById('totalOrders').textContent = orders.length;
      document.getElementById('totalRevenue').textContent = \`\${totalRevenue.toFixed(2)} €\`;
      document.getElementById('totalRefunds').textContent = \`\${totalRefunds.toFixed(2)} €\`;
      document.getElementById('netRevenue').textContent = \`\${netRevenue.toFixed(2)} €\`;
    }

    function resetStats() {
      document.getElementById('totalOrders').textContent = '-';
      document.getElementById('totalRevenue').textContent = '-';
      document.getElementById('totalRefunds').textContent = '-';
      document.getElementById('netRevenue').textContent = '-';
    }

    // Exporter Excel
    function exportExcel() {
      const year = document.getElementById('yearSelect').value;
      const month = document.getElementById('monthSelect').value;
      const statuses = document.getElementById('statusSelect').value;
      const limit = document.getElementById('limitInput').value;
      
      const url = \`/orders-flat?year=\${year}&month=\${month}&statuses=\${statuses}&limit=\${limit}&include_refunds=true&format=excel\`;
      window.open(url, '_blank');
    }

    // Réinitialiser les filtres
    function resetFilters() {
      document.getElementById('yearSelect').value = currentYear;
      document.getElementById('monthSelect').value = currentMonth;
      document.getElementById('statusSelect').value = 'completed,processing';
      document.getElementById('limitInput').value = '100';
      
      document.querySelectorAll('.month-btn').forEach((btn, index) => {
        btn.classList.toggle('active', index + 1 === currentMonth);
      });
      
      loadData();
    }

    // Initialisation
    document.addEventListener('DOMContentLoaded', function() {
      generateQuickMonths();
      document.getElementById('yearSelect').value = currentYear;
      // Charger les données automatiquement au chargement
      setTimeout(loadData, 500);
    });
  </script>
</body>
</html>`);
});
