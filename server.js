const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIG ───────────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'glowbot-beauty-test.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || 'YOUR_ADMIN_API_TOKEN_HERE';

// ─── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GlowBot Middleware is running!' });
});

// ─── CREATE DRAFT ORDER ───────────────────────────────
// Accepts POST (body) or GET (query params) — handles however GHL sends data
app.all('/create-order', async (req, res) => {

  // GHL may send data in body, query params, or nested under different keys
  // Check all possible locations
  const rawBody = req.body || {};
  const rawQuery = req.query || {};

  // GHL sometimes wraps params under a 'parameters' or 'data' key
  const params = Object.keys(rawBody).length > 0 ? rawBody : rawQuery;
  const nested = rawBody.parameters || rawBody.data || rawBody.input || {};

  console.log('=== INCOMING REQUEST ===');
  console.log('Body:', JSON.stringify(rawBody, null, 2));
  console.log('Query:', JSON.stringify(rawQuery, null, 2));
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));

  // Extract data from wherever it lives
  const customer_name    = params.customer_name    || nested.customer_name    || rawQuery.customer_name    || 'Guest Customer';
  let customer_email = params.customer_email || nested.customer_email || rawQuery.customer_email || '';
// Fix @ symbol if GHL stripped it (e.g. "johnatest.com" → "john@test.com")
if (customer_email && !customer_email.includes('@')) {
  customer_email = customer_email.replace(/([a-zA-Z0-9._%+-]+)(at|AT)([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/, '$1@$3');
}
  const shipping_address = params.shipping_address || nested.shipping_address || rawQuery.shipping_address || '';
  const product_title    = params.product_title    || nested.product_title    || rawQuery.product_title    || 'Beauty Product';
  const quantity         = params.quantity         || nested.quantity         || rawQuery.quantity         || 1;

  console.log('Extracted data:', { customer_name, customer_email, shipping_address, product_title });

  // Split name
  const nameParts = customer_name.split(' ');
  const firstName = nameParts[0] || 'Guest';
  const lastName  = nameParts.slice(1).join(' ') || 'Customer';

  // Parse address: "123 Main St, Philadelphia, PA 19103"
  const addressParts = shipping_address.split(',');
  const address1  = (addressParts[0] || '').trim();
  const city      = (addressParts[1] || '').trim();
  const stateZip  = (addressParts[2] || '').trim().split(' ').filter(Boolean);
  const province  = stateZip[0] || '';
  const zip       = stateZip[1] || '';

  // Search Shopify for the product
  let lineItem = {
    title: product_title,
    quantity: parseInt(quantity),
    price: '0.00'
  };

  try {
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const searchData = await searchRes.json();

    // Fuzzy match product title
    const searchTerm = product_title.toLowerCase();
    const match = searchData.products?.find(p =>
      p.title.toLowerCase().includes(searchTerm) ||
      searchTerm.includes(p.title.toLowerCase().split(' ')[0].toLowerCase())
    );

    if (match) {
      const variant = match.variants[0];
      lineItem = {
        variant_id: variant.id,
        quantity: parseInt(quantity),
        title: match.title,
        price: variant.price
      };
      console.log('Matched product:', match.title, 'at $' + variant.price);
    }
  } catch (err) {
    console.log('Product search error:', err.message);
  }

  // Build draft order
  const draftOrder = {
    draft_order: {
      email: customer_email,
      line_items: [lineItem],
      customer: {
        first_name: firstName,
        last_name: lastName,
        email: customer_email
      },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: address1,
        city: city,
        province: province,
        zip: zip,
        country: 'US'
      },
      note: `Order placed via GlowBot AI Voice Assistant | Phone: ${params.phone || ''}`,
      send_invoice: true
    }
  };

  console.log('Sending to Shopify:', JSON.stringify(draftOrder, null, 2));

  try {
    const shopifyRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(draftOrder)
      }
    );

    const shopifyData = await shopifyRes.json();

    if (shopifyData.draft_order) {
      const order = shopifyData.draft_order;
      console.log('Order created:', order.id, order.name);
      res.json({
        success: true,
        order_id: order.id,
        order_number: order.name,
        invoice_url: order.invoice_url,
        total: order.total_price,
        message: `Order ${order.name} placed for ${customer_name}! Payment link: ${order.invoice_url}`
      });
    } else {
      console.log('Shopify error:', shopifyData);
      res.status(400).json({ success: false, error: shopifyData.errors });
    }
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CHECK INVENTORY ──────────────────────────────────
app.all('/check-inventory', async (req, res) => {
  const product_title = req.query.product_title || req.body?.product_title || '';

  try {
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const data = await searchRes.json();
    const searchTerm = product_title.toLowerCase();
    const matches = data.products.filter(p =>
      p.title.toLowerCase().includes(searchTerm)
    );
    res.json({
      success: true,
      products: matches.map(p => ({
        title: p.title,
        price: p.variants[0]?.price || '0.00',
        inventory: p.variants[0]?.inventory_quantity || 0
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── START ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GlowBot Middleware running on port ${PORT}`));
