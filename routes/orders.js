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

    let query = `
      SELECT 
        o.id,
        o.order_batch_id,
        o.status,
        o.total_amount,
        o.payment_status,
        o.created_at,
        o.updated_at,

        -- 🏠 Shipping Address
        CONCAT_WS(', ',
          sa.address_line1,
          sa.address_line2,
          sa.city,
          sa.state,
          sa.postal_code,
          sa.country
        ) AS shipping_address,

        -- 💳 Billing Address
        CONCAT_WS(', ',
          ba.address_line1,
          ba.address_line2,
          ba.city,
          ba.state,
          ba.postal_code,
          ba.country
        ) AS billing_address,

        u.f_name,
        u.l_name,
        u.email
      FROM orders o
      JOIN addresses sa ON o.shipping_address_id = sa.id
      JOIN addresses ba ON o.billing_address_id = ba.id
      JOIN users u ON o.user_id = u.id
    `;

    const params = [];

    if (role === "Super Admin") {
      // Super Admin → sees all orders
      query += ` ORDER BY o.created_at DESC`;
    } else if (role === "Admin" || role === "Manager") {
      // Admin/Manager → only their organization's orders
      query += ` WHERE o.org_id = ? ORDER BY o.created_at DESC`;
      params.push(org_id);
    } else {
      // Unauthorized roles
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
