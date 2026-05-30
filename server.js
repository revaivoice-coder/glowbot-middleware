const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'glowbot-beauty-test.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || 'YOUR_ADMIN_API_TOKEN_HERE';

// ─── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GlowBot Middleware is running!' });
});

// ─── CREATE ORDER ─────────────────────────────────────
app.all('/create-order', async (req, res) => {

  const rawBody = req.body || {};
  const rawQuery = req.query || {};

  console.log('=== INCOMING REQUEST ===');
  console.log('Body:', JSON.stringify(rawBody));
  console.log('Query:', JSON.stringify(rawQuery));

  // Extract data from body or query
  const customer_name    = rawBody.customer_name    || rawQuery.customer_name    || '';
  const shipping_address = rawBody.shipping_address || rawQuery.shipping_address || '';
  const product_title    = rawBody.product_title    || rawQuery.product_title    || '';
  const phone            = rawBody.phone            || rawQuery.phone            || '';

  // Fix email — ignore GHL placeholder values
  let customer_email = rawBody.customer_email || rawQuery.customer_email || '';
  if (
    !customer_email ||
    customer_email.includes('not_provided') ||
    customer_email.includes('example.com') ||
    customer_email === 'none' ||
    customer_email === 'null'
  ) {
    customer_email = '';
  }

  console.log('Extracted:', { customer_name, customer_email, shipping_address, product_title, phone });

  // If no real data return success for GHL test
  if (!customer_name && !product_title) {
    return res.json({
      success: true,
      message: 'GlowBot Order System Ready',
      order_number: 'TEST-001'
    });
  }

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

  // Find product in Shopify
  let lineItem = {
    title: product_title || 'Beauty Product',
    quantity: 1,
    price: '0.00'
  };

  try {
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const searchData = await searchRes.json();
    const searchTerm = product_title.toLowerCase();
    const match = searchData.products?.find(p =>
      p.title.toLowerCase().includes(searchTerm) ||
      searchTerm.includes(p.title.toLowerCase().split(' ')[0].toLowerCase())
    );
    if (match) {
      const variant = match.variants[0];
      lineItem = {
        variant_id: variant.id,
        quantity: 1,
        title: match.title,
        price: variant.price
      };
      console.log('Matched product:', match.title, '$' + variant.price);
    }
  } catch (err) {
    console.log('Product search error:', err.message);
  }

  // Build draft order
  const draftOrder = {
    draft_order: {
      line_items: [lineItem],
      customer: {
        first_name: firstName,
        last_name: lastName,
        ...(customer_email && { email: customer_email })
      },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: address1,
        city: city,
        province: province,
        zip: zip,
        country: 'US',
        ...(phone && { phone: phone })
      },
      note: `Order placed via GlowBot AI Voice Assistant | Phone: ${phone} | Email: ${customer_email}`,
      send_invoice: customer_email ? true : false
    }
  };

  // Only add top level email if we have a valid one
  if (customer_email) {
    draftOrder.draft_order.email = customer_email;
  }

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
      console.log('Order created:', order.name);
      res.json({
        success: true,
        order_id: order.id,
        order_number: order.name,
        invoice_url: order.invoice_url,
        total: order.total_price,
        message: `Order ${order.name} placed for ${customer_name}! ${order.invoice_url ? 'Payment link: ' + order.invoice_url : ''}`
      });
    } else {
      console.log('Shopify error:', shopifyData);
      res.status(400).json({ success: false, error: shopifyData.errors });
    }
  } catch (err) {
    console.error('Error:', err);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GlowBot Middleware running on port ${PORT}`));
