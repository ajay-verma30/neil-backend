const express = require("express");
const router = express.Router();
const authenticateToken = require("../Auth/tokenAuthentication");
const { sendEmail } = require("./mailer");
const mysqlconnect = require("../db/conn");
const { nanoid } = require("nanoid");
require("dotenv").config();


const pool = mysqlconnect();
const promiseConn = pool.promise();

/**
 * 🛒 CREATE NEW ORDER
 */
router.post("/new", authenticateToken, async (req, res) => {
  try {
    const { user, cart, totalAmount } = req.body;

    if (!user?.id || !user?.email || !user?.org_id) {
      return res.status(401).json({
        success: false,
        message: "Please login to continue checkout.",
      });
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty.",
      });
    }

    // ✅ Verify total
    const verifiedTotal = cart
      .reduce((sum, item) => sum + parseFloat(item.price || 0) * (item.quantity || 0), 0)
      .toFixed(2);

    if (parseFloat(verifiedTotal) !== parseFloat(totalAmount)) {
      return res.status(400).json({
        success: false,
        message: "Total amount mismatch. Please refresh and try again.",
      });
    }

    // ✅ Fetch customizations
    const customizationIds = cart.map((item) => item.id);
    const placeholders = customizationIds.map(() => "?").join(",");
    const [customizations] = await promiseConn.query(
      `SELECT id, preview_image_url FROM customizations WHERE id IN (${placeholders})`,
      customizationIds
    );

    if (!customizations.length) {
      return res.status(404).json({
        success: false,
        message: "No matching customizations found.",
      });
    }

    // ✅ Insert orders
   for (const item of cart) {
  const orderId = nanoid(10);
  const price = Number(item.price) || 0;
  const qty = Number(item.quantity) || 0;
  const itemTotal = (parseFloat(item.unit_price) * item.quantity).toFixed(2);

  if (isNaN(itemTotal)) {
    console.warn("⚠️ Skipping invalid cart item:", item);
    continue;
  }

  await promiseConn.query(
    `INSERT INTO orders (id, user_id, customizations_id, org_id, status, total_amount)
     VALUES (?, ?, ?, ?, 'Pending', ?)`,
    [orderId, user.id, item.id, user.org_id, itemTotal]
  );
}


    const orderBatchId = "ORD-" + Date.now();

    // ✅ Email HTML
    const tableRows = cart
      .map((item) => {
        const customization = customizations.find((c) => c.id === item.id);
        const previewUrl = customization
          ? `${process.env.BASE_URL || "http://localhost:3000"}${customization.preview_image_url}`
          : item.image;

        const sizeCells = Object.entries(item.sizes || {})
          .filter(([_, qty]) => qty > 0)
          .map(([size, qty]) => `<div>${size.toUpperCase()}: ${qty}</div>`)
          .join("");

        const subtotal = (parseFloat(item.price) * item.quantity).toFixed(2);

        return `
          <tr>
            <td style="text-align:center;"><img src="${previewUrl}" width="100"/></td>
            <td>${item.title}</td>
            <td>${sizeCells}</td>
            <td>${item.quantity}</td>
            <td>$${item.price}</td>
            <td>$${subtotal}</td>
          </tr>`;
      })
      .join("");

    const html = `
      <h2>Order Confirmation - ${orderBatchId}</h2>
      <p>Dear ${user.name || "Customer"}, thank you for your order!</p>
      <table border="1" cellspacing="0" cellpadding="8" style="border-collapse:collapse;width:100%;">
        <thead>
          <tr style="background:#f2f2f2;text-align:left;">
            <th>Image</th>
            <th>Product</th>
            <th>Sizes</th>
            <th>Quantity</th>
            <th>Price</th>
            <th>Subtotal</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
        <tfoot>
          <tr style="font-weight:bold;">
            <td colspan="5" style="text-align:right;">Total:</td>
            <td>$${verifiedTotal}</td>
          </tr>
        </tfoot>
      </table>
      <p style="margin-top:16px;">We’ll contact you soon with your shipping details.</p>
    `;

    // ✅ Send emails
    if (user.email)
      await sendEmail(user.email, `Your Order Confirmation - ${orderBatchId}`, "Order Confirmation", html);

    if (process.env.EMAIL_ADMIN)
      await sendEmail(process.env.EMAIL_ADMIN, `New Order - ${orderBatchId}`, "New Order Received", html);

    res.json({
      success: true,
      message: "Order placed successfully, confirmation sent.",
      orderBatchId,
      totalAmount: verifiedTotal,
    });
  } catch (error) {
    console.error("❌ Checkout error:", error);
    res.status(500).json({ success: false, message: "Checkout failed." });
  }
});

/**
 * 📦 GET ALL ORDERS (Role-Based)
 */
router.get("/all", authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    let query = `
      SELECT 
        o.id AS order_id,
        o.status,
        o.total_amount,
        o.created_at AS order_date,
        CONCAT(u.f_name, ' ', u.l_name) AS customer_name,
        u.email,
        u.contact,
        org.title AS organization_name,
        c.preview_image_url,
        p.id AS product_id,
        p.title AS product_title,
        p.category AS product_category,
        p.price AS product_price,
        p.sub_cat AS product_subcategory,
        pv.id AS variant_id,
        pv.color AS variant_color,
        pv.size AS variant_size,
        pv.sku AS variant_sku,
        l.id AS logo_id,
        l.title AS logo_title,
        lv.id AS logo_variant_id,
        lv.color AS logo_color,
        lv.url AS logo_url,
        lp.id AS placement_id,
        lp.name AS placement_name,
        lp.view AS placement_view
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN organizations org ON u.org_id = org.id
      JOIN customizations c ON o.customizations_id = c.id
      JOIN product_variants pv ON c.product_variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      JOIN logo_variants lv ON c.logo_variant_id = lv.id
      JOIN logos l ON lv.logo_id = l.id
      JOIN logo_placements lp ON c.placement_id = lp.id
    `;

    const params = [];

    if (user.role === "Super Admin") {
      // No filter
    } else if (["Admin", "Manager"].includes(user.role)) {
      query += " WHERE u.org_id = ?";
      params.push(user.org_id);
    } else if (user.role === "User") {
      query += " WHERE o.user_id = ?";
      params.push(user.id);
    } else {
      return res.status(403).json({ success: false, message: "Unauthorized access." });
    }

    query += " ORDER BY o.created_at DESC";
    const [orders] = await promiseConn.query(query, params);

    res.json({ success: true, count: orders.length, orders });
  } catch (error) {
    console.error("❌ Fetch orders error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
});



//get all orders
router.get("/order-summary", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const conditions = [];
    const params = [];

    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    // Time filter
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
    const [result] = await promiseConn.query(
      `SELECT COUNT(*) AS total_orders FROM orders ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: { total_orders: result[0]?.total_orders || 0 },
    });
  } catch (err) {
    console.error("❌ Error fetching order summary:", err);
    res.status(500).json({ success: false, message: "Server error fetching order summary." });
  }
});


/**
 * Groups orders by date/timeframe, supports org and timeframe filters
 */
router.get("/order-trends", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const conditions = [];
    const params = [];

    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    let dateFormat;
    switch (timeframe) {
      case "day":
        dateFormat = "%H:00";
        conditions.push("DATE(created_at) = CURDATE()");
        break;
      case "week":
        dateFormat = "%a";
        conditions.push("YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)");
        break;
      case "month":
        dateFormat = "%Y-%m-%d";
        conditions.push("MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())");
        break;
      default:
        dateFormat = "%b";
        conditions.push("YEAR(created_at) = YEAR(CURDATE())");
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await promiseConn.query(
      `
      SELECT DATE_FORMAT(created_at, ?) AS period, COUNT(*) AS total_orders
      FROM orders
      ${whereClause}
      GROUP BY period
      ORDER BY MIN(created_at)
      `,
      [dateFormat, ...params]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Error fetching order trends:", err);
    res.status(500).json({ success: false, message: "Server error fetching order trends." });
  }
});



/**
 * ORDER STATUS DISTRIBUTION (for Doughnut Chart)
 */
router.get("/order-status-summary", authenticateToken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const conditions = [];
    const params = [];

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
    const [rows] = await promiseConn.query(
      `
      SELECT status, COUNT(*) AS count
      FROM orders
      ${whereClause}
      GROUP BY status
      ORDER BY status
      `,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Error fetching order status summary:", err);
    res.status(500).json({ success: false, message: "Server error fetching order status summary." });
  }
});



/**
 * 🧾 GET SINGLE ORDER BY ID
 */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const [rows] = await promiseConn.query(
      `
      SELECT 
        o.id AS order_id,
        o.status,
        o.total_amount,
        o.created_at AS order_date,
        CONCAT(u.f_name, ' ', u.l_name) AS customer_name,
        u.email,
        u.contact,
        org.id AS organization_id,
        org.title AS organization_name,
        c.preview_image_url,
        p.id AS product_id,
        p.title AS product_title,
        p.category AS product_category,
        p.price AS product_price,
        p.sub_cat AS product_subcategory,
        pv.id AS variant_id,
        pv.color AS variant_color,
        pv.size AS variant_size,
        pv.sku AS variant_sku,
        l.id AS logo_id,
        l.title AS logo_title,
        lv.id AS logo_variant_id,
        lv.color AS logo_color,
        lv.url AS logo_url,
        lp.id AS placement_id,
        lp.name AS placement_name,
        lp.view AS placement_view
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN organizations org ON u.org_id = org.id
      JOIN customizations c ON o.customizations_id = c.id
      JOIN product_variants pv ON c.product_variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      JOIN logo_variants lv ON c.logo_variant_id = lv.id
      JOIN logos l ON lv.logo_id = l.id
      JOIN logo_placements lp ON c.placement_id = lp.id
      WHERE o.id = ?
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const order = rows[0];

    // Authorization check
    if (
      user.role !== "Super Admin" &&
      !(
        (["Admin", "Manager"].includes(user.role) && user.org_id === order.organization_id) ||
        (user.role === "User" && user.id === order.user_id)
      )
    ) {
      return res.status(403).json({ success: false, message: "Access denied to this order." });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error("❌ Fetch order by ID error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order." });
  }
});


/**
 * ✏️ UPDATE ORDER STATUS
 * Only Super Admin / Admin / Manager can update order status.
 */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;
    const user = req.user;

    if (!["Super Admin", "Admin", "Manager"].includes(user.role)) {
      return res.status(403).json({ success: false, message: "Unauthorized to update orders." });
    }

    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required." });
    }

    const [rows] = await promiseConn.query(
      `SELECT o.id, u.org_id, u.email FROM orders o 
       JOIN users u ON o.user_id = u.id WHERE o.id = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const order = rows[0];

    await promiseConn.query(`UPDATE orders SET status = ? WHERE id = ?`, [status, id]);

    if (order.email) {
      const subject = `Order #${id} Update`;
      const htmlContent = note
        ? `<p>Your order status has been updated to: <strong>${status}</strong></p>
           <p><strong>Note from admin:</strong> ${note}</p>`
        : `<p>Your order status has been updated to: <strong>${status}</strong></p>`;
      await sendEmail(order.email, subject, "Order Update", htmlContent);
    }

    res.json({ success: true, message: "Order updated and email sent successfully." });
  } catch (error) {
    console.error("❌ Update order error:", error);
    res.status(500).json({ success: false, message: "Failed to update order." });
  }
});

module.exports = router;
