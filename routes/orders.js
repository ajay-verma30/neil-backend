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
    const cleanArray = (arr) =>
  arr.map((id) => id?.replace(/['"\[\]]/g, "").trim()).filter(Boolean);

const cartIds = cleanArray(cartItems.map((i) => i.id));
const customizationIds = cleanArray(
  cartItems.map((i) => i.customizations_id)
);
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

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch order + related details
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

        -- Shipping address
        CONCAT_WS(', ',
          sa.address_line1,
          sa.address_line2,
          sa.city,
          sa.state,
          sa.postal_code,
          sa.country
        ) AS shipping_address,

        -- Billing address
        CONCAT_WS(', ',
          ba.address_line1,
          ba.address_line2,
          ba.city,
          ba.state,
          ba.postal_code,
          ba.country
        ) AS billing_address,

        -- User details
        u.f_name,
        u.l_name,
        u.email
      FROM orders o
      JOIN addresses sa ON o.shipping_address_id = sa.id
      JOIN addresses ba ON o.billing_address_id = ba.id
      JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
      `,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const order = rows[0];
const customization_details = [];
const cart = order.cart_id;

for (let i = 0; i < cart.length; i++) {
  const [rows] = await promiseConn.query(
    `SELECT 
      ct.title,
      ct.image,
      ct.sizes,
      ct.quantity,
      lp.name AS placement_name,
      lp.view AS placement_view,
      lv.color AS logo_color,
      pv.color AS product_color,
      pv.sku AS product_sku
    FROM cart_items ct
    JOIN customizations c ON ct.customizations_id = c.id
    JOIN logo_placements lp ON c.placement_id = lp.id
    JOIN logo_variants lv ON c.logo_variant_id = lv.id
    JOIN product_variants pv ON c.product_variant_id = pv.id
    WHERE ct.id = ?`,
    [cart[i]]
  );

  if (rows.length > 0) {
    customization_details.push(rows[0]);
  }
}
    return res.status(200).json({
      success: true,
      data: {
        id: order.id,
        order_batch_id: order.order_batch_id,
        status: order.status,
        total_amount: order.total_amount,
        payment_status: order.payment_status,
        payment_method: order.payment_method,
        cart_ids: order.cart_id,
        customizationDetails: customization_details,
        shipping_address: order.shipping_address,
        billing_address: order.billing_address,
        created_at: order.created_at,
        updated_at: order.updated_at,
        customer: {
          f_name: order.f_name,
          l_name: order.l_name,
          email: order.email
        }
      }
    });
  } catch (err) {
    console.error("Error fetching order:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});


//summary
router.get("/order-summary", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;
    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
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
          conditions.push(
            "MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())"
          );
          break;
        case "year":
          conditions.push("YEAR(created_at) = YEAR(CURDATE())");
          break;
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // 🧮 Query total orders
    const [totalOrdersResult] = await promiseConn.query(
      `
      SELECT COUNT(*) AS total_orders
      FROM orders ${whereClause}
      `,
      params
    );

    const totalOrders = totalOrdersResult[0]?.total_orders || 0;

    // ✅ Send response
    res.json({
      success: true,
      data: {
        total_orders: totalOrders,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching order summary:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching order summary.",
    });
  }
});








module.exports = router;
