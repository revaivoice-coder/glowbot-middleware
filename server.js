const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────
// Set these as environment variables on Render.com
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'glowbot-beauty-test.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || 'YOUR_ADMIN_API_TOKEN_HERE';

// ─── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GlowBot Middleware is running!' });
});

// ─── CREATE DRAFT ORDER ───────────────────────────────
// GHL calls this endpoint with simple parameters
// We reformat and send to Shopify
app.post('/create-order', async (req, res) => {
  console.log('Received order request:', req.body);

  const {
    customer_name,
    customer_email,
    shipping_address,
    product_title,
    quantity = 1,
    price
  } = req.body;

  // Split customer name into first and last
  const nameParts = (customer_name || 'Guest Customer').split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || '';

  // Parse shipping address
  // Expected format: "123 Main St, Philadelphia, PA 19103"
  const addressParts = (shipping_address || '').split(',');
  const address1 = (addressParts[0] || '').trim();
  const city = (addressParts[1] || '').trim();
  const stateZip = (addressParts[2] || '').trim().split(' ');
  const province = stateZip[0] || '';
  const zip = stateZip[1] || '';

  // First search Shopify for the product to get variant ID and price
  let lineItem = {
    title: product_title || 'Beauty Product',
    quantity: parseInt(quantity),
    price: price || '0.00'
  };

  try {
    // Search for the product in Shopify
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?title=${encodeURIComponent(product_title || '')}&limit=5`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    const searchData = await searchRes.json();

    if (searchData.products && searchData.products.length > 0) {
      const product = searchData.products[0];
      const variant = product.variants[0];
      lineItem = {
        variant_id: variant.id,
        quantity: parseInt(quantity),
        title: product.title,
        price: variant.price
      };
      console.log('Found product:', product.title, 'Price:', variant.price);
    }
  } catch (err) {
    console.log('Product search failed, using manual entry:', err.message);
  }

  // Build the Shopify draft order payload
  const draftOrder = {
    draft_order: {
      line_items: [lineItem],
      customer: {
        first_name: firstName,
        last_name: lastName,
        email: customer_email || ''
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
      note: 'Order placed via GlowBot AI Voice Assistant',
      send_invoice: true // Automatically sends payment link to customer
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
      console.log('Order created successfully:', order.id);

      res.json({
        success: true,
        order_id: order.id,
        order_number: order.name,
        invoice_url: order.invoice_url,
        total: order.total_price,
        message: `Order ${order.name} created successfully! Payment link sent to ${customer_email}`
      });
    } else {
      console.log('Shopify error:', shopifyData);
      res.status(400).json({
        success: false,
        error: shopifyData.errors || 'Failed to create order',
        details: shopifyData
      });
    }
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ─── CHECK INVENTORY ──────────────────────────────────
// Optional: also proxy inventory checks
app.get('/check-inventory', async (req, res) => {
  const { product_title } = req.query;

  try {
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    const data = await searchRes.json();

    // Filter products that match the search term
    const searchTerm = (product_title || '').toLowerCase();
    const matches = data.products.filter(p =>
      p.title.toLowerCase().includes(searchTerm)
    );

    if (matches.length > 0) {
      const results = matches.map(p => ({
        title: p.title,
        price: p.variants[0]?.price || '0.00',
        inventory: p.variants[0]?.inventory_quantity || 0,
        available: (p.variants[0]?.inventory_quantity || 0) > 0
      }));
      res.json({ success: true, products: results });
    } else {
      res.json({ success: true, products: [], message: 'No products found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlowBot Middleware running on port ${PORT}`);
});
