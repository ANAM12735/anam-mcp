const express = require('express');
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const axios = require('axios');
const _ = require('lodash');
const { Parser } = require('json2csv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone');

const app = express();
const port = process.env.PORT || 3000;

// Configuration WooCommerce
const wooCommerce = new WooCommerceRestApi({
  url: process.env.WOO_URL,
  consumerKey: process.env.WOO_CONSUMER_KEY,
  consumerSecret: process.env.WOO_CONSUMER_SECRET,
  version: 'wc/v3',
  queryStringAuth: true
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Fonction pour récupérer les remboursements détaillés
async function getDetailedRefunds(orderId) {
  try {
    const response = await wooCommerce.get(`orders/${orderId}/refunds`);
    const refunds = response.data;
    
    const detailedRefunds = [];
    
    for (const refund of refunds) {
      // Calcul du montant total du remboursement (articles + livraison)
      let refundAmount = 0;
      
      // Articles remboursés
      if (refund.line_items && Array.isArray(refund.line_items)) {
        for (const item of refund.line_items) {
          refundAmount += Math.abs(parseFloat(item.total) || 0);
        }
      }
      
      // Frais de livraison remboursés
      if (refund.shipping_lines && Array.isArray(refund.shipping_lines)) {
        for (const shipping of refund.shipping_lines) {
          refundAmount += Math.abs(parseFloat(shipping.total) || 0);
        }
      }
      
      // Si pas de détail, on utilise le montant global
      if (refundAmount === 0) {
        refundAmount = Math.abs(parseFloat(refund.amount) || 0);
      }
      
      detailedRefunds.push({
        id: refund.id,
        date: refund.date_created,
        amount: refundAmount,
        reason: refund.reason,
        line_items: refund.line_items,
        shipping_lines: refund.shipping_lines
      });
    }
    
    return detailedRefunds;
  } catch (error) {
    console.error(`Erreur remboursements commande ${orderId}:`, error.message);
    return [];
  }
}

// Route principale - Tableau de bord
app.get('/dashboard', async (req, res) => {
  try {
    const { month = '2025-06', status = 'completed,processing' } = req.query;
    
    // Calcul des dates pour le mois demandé
    const startDate = `${month}-01T00:00:00`;
    const endDate = moment(`${month}-01`).endOf('month').format('YYYY-MM-DDTHH:mm:ss');
    
    // Récupération des commandes
    const ordersResponse = await wooCommerce.get('orders', {
      after: startDate,
      before: endDate,
      status: status.split(','),
      per_page: 100,
      orderby: 'date',
      order: 'asc'
    });
    
    const orders = ordersResponse.data;
    
    // Calcul des statistiques
    let totalRevenue = 0;
    let totalShipping = 0;
    let totalRefunds = 0;
    let totalOrders = orders.length;
    
    for (const order of orders) {
      const orderTotal = parseFloat(order.total) || 0;
      const shippingTotal = parseFloat(order.shipping_total) || 0;
      
      totalRevenue += orderTotal;
      totalShipping += shippingTotal;
      
      // Remboursements pour cette commande
      const refunds = await getDetailedRefunds(order.id);
      const orderRefunds = refunds.reduce((sum, refund) => sum + refund.amount, 0);
      totalRefunds += orderRefunds;
    }
    
    // Calcul du revenu net (identique à ton Excel)
    const netRevenue = totalRevenue - totalRefunds;
    
    res.json({
      month,
      totalOrders,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalShipping: Math.round(totalShipping * 100) / 100,
      totalRefunds: Math.round(totalRefunds * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100, // ← CORRECTION IMPORTANTE
      orders: orders.map(order => ({
        id: order.id,
        number: order.number,
        date: order.date_created,
        status: order.status,
        total: parseFloat(order.total) || 0,
        shipping: parseFloat(order.shipping_total) || 0,
        customer: `${order.billing.first_name} ${order.billing.last_name}`.trim()
      }))
    });
    
  } catch (error) {
    console.error('Erreur dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route pour les données brutes (export Excel)
app.get('/orders-flat', async (req, res) => {
  try {
    const { 
      month = '2025-06', 
      status = 'completed,processing',
      includeRefunds = 'true'
    } = req.query;
    
    const startDate = `${month}-01T00:00:00`;
    const endDate = moment(`${month}-01`).endOf('month').format('YYYY-MM-DDTHH:mm:ss');
    
    const ordersResponse = await wooCommerce.get('orders', {
      after: startDate,
      before: endDate,
      status: status.split(','),
      per_page: 100
    });
    
    const orders = ordersResponse.data;
    const rows = [];
    
    for (const order of orders) {
      const orderTotal = parseFloat(order.total) || 0;
      const shippingTotal = parseFloat(order.shipping_total) || 0;
      const discountTotal = parseFloat(order.discount_total) || 0;
      
      // Ligne de la commande principale
      rows.push({
        date: order.date_created.replace('T', ' ').replace('Z', ''),
        reference: order.number,
        nom: (order.billing.last_name || '').trim(),
        prenom: (order.billing.first_name || '').trim(),
        nature: 'Payé',
        moyen_paiement: order.payment_method_title || order.payment_method || '',
        montant: orderTotal,
        frais_livraison: shippingTotal,
        reduction: discountTotal,
        currency: order.currency || 'EUR',
        status: order.status,
        ville: order.billing.city || order.shipping.city || ''
      });
      
      // Lignes de remboursements si demandé
      if (includeRefunds === 'true') {
        const refunds = await getDetailedRefunds(order.id);
        
        for (const refund of refunds) {
          rows.push({
            date: refund.date.replace('T', ' ').replace('Z', ''),
            reference: `${order.number}-R${refund.id}`,
            nom: (order.billing.last_name || '').trim(),
            prenom: (order.billing.first_name || '').trim(),
            nature: 'Remboursé',
            moyen_paiement: order.payment_method_title || order.payment_method || '',
            montant: -refund.amount, // Négatif pour remboursement
            frais_livraison: 0,
            reduction: 0,
            currency: order.currency || 'EUR',
            status: 'refunded',
            ville: order.billing.city || order.shipping.city || ''
          });
        }
      }
    }
    
    // Tri par date
    rows.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    res.json({ rows });
    
  } catch (error) {
    console.error('Erreur orders-flat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export Excel (identique à ton format actuel)
app.get('/export-excel', async (req, res) => {
  try {
    const { month = '2025-06' } = req.query;
    
    const response = await axios.get(`http://localhost:${port}/orders-flat`, {
      params: { month, includeRefunds: 'true' }
    });
    
    const { rows } = response.data;
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Commandes');
    
    // En-têtes identiques à ton export actuel
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Référence', key: 'reference', width: 15 },
      { header: 'Nom', key: 'nom', width: 20 },
      { header: 'Prénom', key: 'prenom', width: 20 },
      { header: 'Nature', key: 'nature', width: 15 },
      { header: 'Moyen de paiement', key: 'moyen_paiement', width: 20 },
      { header: 'Montant encaissé', key: 'montant', width: 15 },
      { header: 'Frais de livraison', key: 'frais_livraison', width: 15 },
      { header: 'Réduction', key: 'reduction', width: 15 },
      { header: 'Ville', key: 'ville', width: 15 }
    ];
    
    // Ajout des données
    worksheet.addRows(rows);
    
    // Formatage des nombres
    worksheet.getColumn('montant').numFmt = '#,##0.00';
    worksheet.getColumn('frais_livraison').numFmt = '#,##0.00';
    worksheet.getColumn('reduction').numFmt = '#,##0.00';
    
    // En-têtes en gras
    worksheet.getRow(1).font = { bold: true };
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=commandes-${month}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Erreur export Excel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route de santé
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Dashboard MCP démarré sur le port ${port}`);
});
