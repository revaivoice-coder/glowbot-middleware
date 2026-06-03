const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'glowbot-beauty-test.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || 'YOUR_ADMIN_API_TOKEN_HERE';
const GHL_API_KEY = process.env.GHL_API_KEY || 'YOUR_GHL_API_KEY_HERE';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'YOUR_LOCATION_ID_HERE';

// ─── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GlowBot Middleware is running!' });
});

// ─── PARSE MULTI-ITEM ORDER ───────────────────────────
// Takes "3 Color Safe Shampoos, 2 Jamaican Black Castor Oils, 1 Deep Moisture Hair Mask"
// Returns [{qty: 3, name: "Color Safe Shampoo"}, ...]
function parseOrderItems(quantityStr, productStr) {
  const items = [];

  // Try parsing from quantity field first (has qty + name)
  // Format: "3 Color Safe Shampoos, 2 Jamaican Black Castor Oils, 1 Deep Moisture Hair Mask"
  if (quantityStr && quantityStr.match(/\d/)) {
    const parts = quantityStr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (match) {
        items.push({
          qty: parseInt(match[1]),
          name: match[2].trim().replace(/s$/, '') // remove trailing 's' for plural
        });
      }
    }
  }

  // Fallback: use product_title with qty 1
  if (items.length === 0 && productStr) {
    const products = productStr.split(',');
    for (const p of products) {
      items.push({ qty: 1, name: p.trim() });
    }
  }

  return items;
}

// ─── FIND SHOPIFY PRODUCT ─────────────────────────────
async function findProduct(allProducts, searchTerm) {
  const term = searchTerm.toLowerCase()
    .replace(/shampoos?/gi, 'shampoo')
    .replace(/masks?/gi, 'mask')
    .replace(/oils?/gi, 'oil')
    .replace(/creams?/gi, 'cream')
    .replace(/gels?/gi, 'gel')
    .trim();

  const match = allProducts.find(p => {
    const title = p.title.toLowerCase();
    return title.includes(term) ||
      term.includes(title.split(' ')[0].toLowerCase()) ||
      term.split(' ').some(word => word.length > 3 && title.includes(word));
  });

  return match || null;
}

// ─── CREATE ORDER ─────────────────────────────────────
app.all('/create-order', async (req, res) => {

  const rawBody = req.body || {};
  const rawQuery = req.query || {};

  console.log('=== INCOMING REQUEST ===');
  console.log('Query:', JSON.stringify(rawQuery));

  // Extract data
  const customer_name    = rawBody.customer_name    || rawQuery.customer_name    || '';
  const shipping_address = rawBody.shipping_address || rawQuery.shipping_address || '';
  const product_title    = rawBody.product_title    || rawQuery.product_title    || '';
  const quantity_str     = rawBody.quantity         || rawQuery.quantity         || '';
  const phone            = rawBody.Phone            || rawQuery.Phone            ||
                           rawBody.phone            || rawQuery.phone            || '';

  // Fix email
  let customer_email = rawBody.customer_email  || rawQuery.customer_email  ||
                       rawBody.customer_emai   || rawQuery.customer_emai   || '';
  if (!customer_email || customer_email.includes('not_provided') || customer_email.includes('example.com')) {
    customer_email = '';
  }

  console.log('Extracted:', { customer_name, customer_email, shipping_address, product_title, quantity_str, phone });

  // Return success for GHL test (no real data)
  if (!customer_name && !product_title) {
    return res.json({ success: true, message: 'GlowBot Order System Ready', order_number: 'TEST-001' });
  }

  // Also return success if this looks like a test value
  if (quantity_str === '1234567890' || product_title === '1234567890') {
    return res.json({ success: true, message: 'GlowBot Order System Ready', order_number: 'TEST-001' });
  }

  // Split name
  const nameParts = customer_name.split(' ');
  const firstName = nameParts[0] || 'Guest';
  const lastName  = nameParts.slice(1).join(' ') || 'Customer';

  // Parse address
  const addressParts = shipping_address.split(',');
  const address1 = (addressParts[0] || '').trim();
  const city     = (addressParts[1] || '').trim();
  const stateZip = (addressParts[2] || '').trim().split(' ').filter(Boolean);
  const province = stateZip[0] || '';
  const zip      = stateZip[1] || '';

  // Parse order items
  const orderItems = parseOrderItems(quantity_str, product_title);
  console.log('Order items to process:', orderItems);

  // Fetch all Shopify products once
  let allProducts = [];
  try {
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const data = await searchRes.json();
    allProducts = data.products || [];
  } catch (err) {
    console.log('Product fetch error:', err.message);
  }

  // Build line items for all ordered products
  const lineItems = [];
  for (const item of orderItems) {
    const match = await findProduct(allProducts, item.name);
    if (match) {
      const variant = match.variants[0];
      lineItems.push({
        variant_id: variant.id,
        quantity: item.qty,
        title: match.title,
        price: variant.price
      });
      console.log(`Matched: ${item.qty}x ${match.title} @ $${variant.price}`);
    } else {
      // Add as custom item if not found
      lineItems.push({
        title: item.name,
        quantity: item.qty,
        price: '0.00'
      });
      console.log(`Not found, adding as custom: ${item.qty}x ${item.name}`);
    }
  }

  // Fallback if no items parsed
  if (lineItems.length === 0) {
    lineItems.push({ title: product_title || 'Beauty Product', quantity: 1, price: '0.00' });
  }

  // Build draft order
  const draftOrder = {
    draft_order: {
      line_items: lineItems,
      customer: {
        first_name: firstName,
        last_name: lastName,
        ...(customer_email && { email: customer_email })
      },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1,
        city,
        province,
        zip,
        country: 'US',
        ...(phone && { phone })
      },
      note: `Order placed via GlowBot AI Voice Assistant | Phone: ${phone} | Email: ${customer_email}`,
      send_invoice: !!customer_email,
      ...(customer_email && { email: customer_email })
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
      console.log('Order created:', order.name, '| Items:', lineItems.length);

      // ─── SEND SMS PAYMENT LINK VIA GHL ───────────────
      if (phone && order.invoice_url && GHL_API_KEY && GHL_LOCATION_ID) {
        try {
          // Create or find contact in GHL
          const contactRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            },
            body: JSON.stringify({
              firstName,
              lastName,
              phone,
              locationId: GHL_LOCATION_ID,
              ...(customer_email && { email: customer_email })
            })
          });
          const contactData = await contactRes.json();
          const contactId = contactData.contact?.id;
          console.log('GHL Contact created/found:', contactId);

          // Send SMS with payment link
          if (contactId) {
            const smsRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
              },
              body: JSON.stringify({
                type: 'SMS',
                contactId,
                message: `Hi ${firstName}! Your order from Glow Beauty Supply is ready 🛍️\n\nOrder: ${order.name}\nTotal: $${order.total_price}\n\nClick to pay: ${order.invoice_url}\n\nThank you for shopping with us!`
              })
            });
            const smsData = await smsRes.json();
            console.log('SMS sent:', JSON.stringify(smsData));
          }
        } catch (smsErr) {
          console.log('SMS error (non-fatal):', smsErr.message);
        }
      }

      res.json({
        success: true,
        order_id: order.id,
        order_number: order.name,
        invoice_url: order.invoice_url,
        total: order.total_price,
        items_ordered: lineItems.length,
        message: `Order ${order.name} placed for ${customer_name} with ${lineItems.length} item(s)! Total: $${order.total_price}`
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
    const matches = data.products.filter(p => p.title.toLowerCase().includes(searchTerm));
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
