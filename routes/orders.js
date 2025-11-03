const express = require("express");
const router = express.Router();
const authenticateToken = require("../Auth/tokenAuthentication");
const { sendEmail } = require("./mailer");
const mysqlconnect = require("../db/conn");
const { nanoid } = require("nanoid");
require("dotenv").config();

// Database connection
const pool = mysqlconnect();
const promiseConn = pool.promise();

router.post("/create", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { shipping_address_id, billing_address_id, payment_method } = req.body;
    const [cartItems] = await promiseConn.query(
      "SELECT * FROM cart_items WHERE user_id = ? AND ordered = 0",
      [userId]
    );

    if (!cartItems.length) {
      return res.status(400).json({ success: false, message: "No items in cart." });
    }
    const cartIds = cartItems.map(i => i.id);
    const customizationIds = cartItems
      .map(i => i.customizations_id)
      .filter(id => id !== null);
    const totalAmount = cartItems.reduce(
      (sum, item) => sum + parseFloat(item.total_price),
      0
    );

    const orderId = "ORD-" + nanoid(8);
    const batchId = "BATCH-" + nanoid(6);
    await promiseConn.query(
      `INSERT INTO orders 
      (id, user_id, org_id, order_batch_id, shipping_address_id, billing_address_id, 
       total_amount, cart_id, customizations_id, status, payment_status, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Unpaid', ?)`,
      [
        orderId,
        userId,
        "ORG001",
        batchId,
        shipping_address_id,
        billing_address_id,
        totalAmount,
        JSON.stringify(cartIds),
        JSON.stringify(customizationIds),
        payment_method
      ]
    );

    for (const item of cartItems) {
      await promiseConn.query("UPDATE cart_items SET ordered = 1 WHERE id = ?", [item.id]);
    }
    res.json({
      success: true,
      message: "Order created successfully",
      orderId,
      totalAmount
    });
  } catch (err) {
    console.error("Error creating order:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});



router.get("/my-orders", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [orders] = await promiseConn.query(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC",
      [userId]
    );
    const safeParse = (data) => {
      if (!data) return [];
      if (Array.isArray(data)) return data;
      try {
        return JSON.parse(data);
      } catch {
        return data
          .toString()
          .replace(/[\[\]\"]/g, "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean);
      }
    };

    const formattedOrders = orders.map(order => ({
      ...order,
      cart_id: safeParse(order.cart_id),
      customizations_id: safeParse(order.customizations_id)
    }));

    res.json({
      success: true,
      count: formattedOrders.length,
      orders: formattedOrders
    });
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});


router.get("/all-orders", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;

    let query = `SELECT 
  o.id,
  o.order_batch_id,
  o.status,
  o.total_amount,
  o.payment_status,
  o.created_at,
  o.updated_at,

  -- Shipping address
  sa.type AS shipping_type,
  sa.address_line1 AS shipping_address_line1,
  sa.address_line2 AS shipping_address_line2,
  sa.city AS shipping_city,
  sa.state AS shipping_state,
  sa.postal_code AS shipping_postal_code,
  sa.country AS shipping_country,
  sa.is_default AS shipping_is_default,

  -- Billing address
  ba.type AS billing_type,
  ba.address_line1 AS billing_address_line1,
  ba.address_line2 AS billing_address_line2,
  ba.city AS billing_city,
  ba.state AS billing_state,
  ba.postal_code AS billing_postal_code,
  ba.country AS billing_country,
  ba.is_default AS billing_is_default,

  -- User info
  u.f_name,
  u.l_name,
  u.email,

  -- Cart item images
  JSON_ARRAYAGG(ci.image) AS cart_images,

  -- Customization details
  GROUP_CONCAT(DISTINCT c.id) AS customization_ids,
  GROUP_CONCAT(DISTINCT c.preview_image_url) AS customization_images,
  GROUP_CONCAT(DISTINCT c.product_variant_id) AS customization_product_variants,
  GROUP_CONCAT(DISTINCT c.logo_variant_id) AS customization_logo_variants,
  GROUP_CONCAT(DISTINCT c.placement_id) AS customization_placements,
  GROUP_CONCAT(DISTINCT c.created_at) AS customization_created_dates

FROM orders o
JOIN addresses sa ON o.shipping_address_id = sa.id
JOIN addresses ba ON o.billing_address_id = ba.id
JOIN users u ON o.user_id = u.id

-- Expand JSON arrays for cart items
LEFT JOIN JSON_TABLE(
  o.cart_id,
  '$[*]' COLUMNS (cart_item_id VARCHAR(15) PATH '$')
) AS jt_cart ON TRUE
LEFT JOIN cart_items ci 
  ON ci.id COLLATE utf8mb4_unicode_ci = jt_cart.cart_item_id COLLATE utf8mb4_unicode_ci

-- Expand JSON arrays for customizations
LEFT JOIN JSON_TABLE(
  o.customizations_id,
  '$[*]' COLUMNS (custom_id VARCHAR(15) PATH '$')
) AS jt_custom ON TRUE
LEFT JOIN customizations c 
  ON c.id COLLATE utf8mb4_unicode_ci = jt_custom.custom_id COLLATE utf8mb4_unicode_ci

GROUP BY o.id
ORDER BY o.created_at DESC;

    `;

    // 🧠 Authorization-based filtering
    const params = [];

    if (role === "Super Admin") {
      // Super Admin → sees all orders (no filter)
      query += ` GROUP BY o.id ORDER BY o.created_at DESC`;
    } else if (role === "Admin" || role === "Manager") {
      // Admin/Manager → see only orders of their organization
      query += ` WHERE o.org_id = ? GROUP BY o.id ORDER BY o.created_at DESC`;
      params.push(org_id);
    } else {
      // Others → forbidden
      return res.status(403).json({
        success: false,
        message: "Unauthorized access",
      });
    }

    const [orders] = await promiseConn.query(query, params);

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});



module.exports = router;
