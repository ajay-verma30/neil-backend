const express = require("express");
const router = express.Router();
const authenticateToken = require("../Auth/tokenAuthentication");
const { sendEmail } = require("./mailer");
const mysqlconnect = require("../db/conn");
const { nanoid } = require("nanoid");
require("dotenv").config();


const pool = mysqlconnect();
const promiseConn = pool.promise();

router.post("/create", authenticateToken, async (req, res) => {
  let conn;
  try {
    conn = await promiseConn.getConnection();
    await conn.beginTransaction();

    const userId = req.user.id;
    const { shipping_address_id, billing_address_id, payment_method } = req.body;
    const [cartItems] = await conn.query(
      "SELECT * FROM cart_items WHERE user_id = ? AND ordered = 0",
      [userId]
    );

    if (!cartItems.length) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "No items in cart.",
      });
    }
    const cleanArray = (arr) =>
      arr
        .map((id) => id?.replace(/['"\\[\\]]/g, "").trim())
        .filter(Boolean);

    const cartIds = cleanArray(cartItems.map((i) => i.id));
    const customizationIds = cleanArray(cartItems.map((i) => i.customizations_id));

    const totalAmount = cartItems.reduce(
      (sum, item) => sum + parseFloat(item.total_price || 0),
      0
    );

    const orderId = "ORD-" + nanoid(8);
    const batchId = "BATCH-" + nanoid(6);
    await conn.query(
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
        payment_method,
      ]
    );
    for (const item of cartItems) {
      await conn.query("UPDATE cart_items SET ordered = 1 WHERE id = ?", [item.id]);
    }
    const [[user]] = await conn.query(
      "SELECT f_name, l_name, email FROM users WHERE id = ?",
      [userId]
    );
    const orderDetails = cartItems
  .map((item) => {
    const price = parseFloat(item.total_price || 0);
    return `
      <tr>
        <td>${item.title}</td>
        <td>${item.quantity}</td>
        <td>$${price.toFixed(2)}</td>
      </tr>
    `;
  })
  .join("");


    const emailHtml = `
      <h2>Order Confirmation - Neil Prints</h2>
      <p>Hi ${user.f_name},</p>
      <p>Thank you for your order! Your order <b>${orderId}</b> has been successfully placed.</p>
      <table border="1" cellspacing="0" cellpadding="8" style="border-collapse: collapse; width:100%; margin-top:10px;">
        <thead style="background:#f5f5f5;">
          <tr>
            <th align="left">Product</th>
            <th align="center">Qty</th>
            <th align="right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${orderDetails}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" align="right"><b>Total:</b></td>
            <td align="right"><b>$${totalAmount.toFixed(2)}</b></td>
          </tr>
        </tfoot>
      </table>
      <p style="margin-top:20px;">
        <b>Payment Method:</b> ${payment_method}<br/>
        <b>Status:</b> Pending
      </p>
      <p>We'll notify you when your order ships!</p>
      <p>Thank you for choosing Neil Prints!</p>
    `;
    await sendEmail(user.email, `Order Confirmation - ${orderId}`, emailHtml);
    await conn.commit();
    res.json({
      success: true,
      message: "Order created successfully. Confirmation email sent.",
      orderId,
      totalAmount,
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("❌ Error creating order:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error while creating order.",
    });
  } finally {
    if (conn) conn.release();
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
        o.org_id,

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
      // ✅ Can see all orders
      query += ` ORDER BY o.created_at DESC`;
    } else if (role === "Admin" || role === "Manager") {
      // ✅ Can see only their org's orders
      query += ` WHERE o.org_id = ? ORDER BY o.created_at DESC`;
      params.push(org_id);
    } else {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }

    const [orders] = await promiseConn.query(query, params);

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (err) {
    console.error("❌ Error fetching orders:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});


router.get("/order-trends", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    let conditions = [];
    let params = [];

    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    let groupBy = "DATE(created_at)";
    if (timeframe === "month") groupBy = "DATE_FORMAT(created_at, '%Y-%m-%d')";
    if (timeframe === "year") groupBy = "MONTH(created_at)";

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await promiseConn.query(
      `
      SELECT 
        ${groupBy} AS period,
        COUNT(*) AS total_orders
      FROM orders
      ${whereClause}
      GROUP BY period
      ORDER BY period ASC
      `,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Error fetching order trends:", err);
    res.status(500).json({ success: false, message: "Server error while fetching order trends." });
  }
});



router.get("/order-status-summary", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    let conditions = [];
    let params = [];

    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    // 🕓 Time filter
    if (timeframe) {
      switch (timeframe) {
        case "day":
          conditions.push("DATE(created_at) = CURDATE()");
          break;
        case "week":
          conditions.push("YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)");
          break;
        case "month":
          conditions.push("MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())");
          break;
        case "year":
          conditions.push("YEAR(created_at) = YEAR(CURDATE())");
          break;
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await promiseConn.query(
      `
      SELECT 
        status,
        COUNT(*) AS count
      FROM orders
      ${whereClause}
      GROUP BY status
      `,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Error fetching order status summary:", err);
    res.status(500).json({ success: false, message: "Server error while fetching order status summary." });
  }
});


//summary
router.get("/order-summary", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    let conditions = [];
    let params = [];

    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    if (timeframe) {
      switch (timeframe) {
        case "day":
          conditions.push("DATE(created_at) = CURDATE()");
          break;
        case "week":
          conditions.push("YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)");
          break;
        case "month":
          conditions.push("MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())");
          break;
        case "year":
          conditions.push("YEAR(created_at) = YEAR(CURDATE())");
          break;
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [totalOrdersResult] = await promiseConn.query(
      `SELECT COUNT(*) AS total_orders FROM orders ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: { total_orders: totalOrdersResult[0]?.total_orders || 0 },
    });
  } catch (err) {
    console.error("❌ Error fetching order summary:", err);
    res.status(500).json({ success: false, message: "Server error while fetching order summary." });
  }
});




router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { role, org_id } = req.user;

    // Fetch order with org info
    const [rows] = await promiseConn.query(
      `
      SELECT 
        o.id,
        o.order_batch_id,
        o.status,
        o.total_amount,
        o.payment_status,
        o.payment_method,
        o.cart_id,
        o.customizations_id,
        o.created_at,
        o.updated_at,
        o.org_id,

        sa.address_line1 AS sa_line1, sa.city AS sa_city, sa.state AS sa_state,
        ba.address_line1 AS ba_line1, ba.city AS ba_city, ba.state AS ba_state,

        u.f_name, u.l_name, u.email
      FROM orders o
      JOIN addresses sa ON o.shipping_address_id = sa.id
      JOIN addresses ba ON o.billing_address_id = ba.id
      JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    // 🔒 Restrict visibility based on org
    if (role !== "Super Admin" && order.org_id !== org_id) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to view this order.",
      });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});




module.exports = router;
