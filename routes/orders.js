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
    const org_id = req.user.org_id;

    // ❌ Removed 'preview_url' from req.body, it must be derived from cart items
    const { 
      shipping_address_id, 
      billing_address_id,
      payment_status, 
      payment_method, 
    } = req.body;

    // 🛒 Fetch cart items
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

    // 💡 FIX: Get the image URL from the FIRST item to populate the single 'preview_url' column
    const preview_url = cartItems[0].image;

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

    // ✅ Insert the first item's image URL into the main orders table
    await conn.query(
      `INSERT INTO orders 
      (id, user_id, org_id, order_batch_id, shipping_address_id, billing_address_id, 
       total_amount, cart_id, customizations_id, preview_url, status, payment_status, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
      [
        orderId,
        userId,
        org_id,
        batchId,
        shipping_address_id,
        billing_address_id,
        totalAmount,
        JSON.stringify(cartIds),
        JSON.stringify(customizationIds),
        preview_url || null, 
        payment_status,
        payment_method,
      ]
    );

    // 🛒 Mark all items as ordered
    for (const item of cartItems) {
      await conn.query("UPDATE cart_items SET ordered = 1 WHERE id = ?", [item.id]);
    }

    // 👤 Fetch user details
    const [[user]] = await conn.query(
      "SELECT f_name, l_name, email FROM users WHERE id = ?",
      [userId]
    );

    const orderDetails = cartItems
      .map((item) => {
        const price = parseFloat(item.total_price || 0);
        return `
          <tr>
            <td>
                <img src="${item.image}" alt="${item.title}" style="max-width:50px; height:auto; margin-right: 10px; border-radius: 4px; vertical-align: middle;">
                ${item.title}
            </td>
            <td align="center">${item.quantity}</td>
            <td align="right">$${price.toFixed(2)}</td>
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
            <th align="left" style="width: 60%">Product</th>
            <th align="center" style="width: 20%">Qty</th>
            <th align="right" style="width: 20%">Subtotal</th>
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
      preview_url: preview_url || null,
    });

  } catch (err) {
    if (conn) await conn.rollback();
    console.error("❌ Error creating order:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error while creating order.",
      error: err.sqlMessage || err.message,
    });
  } finally {
    if (conn) conn.release();
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
      // ✅ Super Admin → fetch all orders
      query += ` ORDER BY o.created_at DESC`;
    } else if (role === "Admin" || role === "Manager") {
      // ✅ Admin / Manager → fetch orders of their organization only
      query += ` WHERE o.org_id = ? ORDER BY o.created_at DESC`;
      params.push(org_id);
    } else {
      // ❌ Other roles — deny access
      return res.status(403).json({
        success: false,
        message: "Unauthorized access.",
      });
    }

    const [orders] = await promiseConn.query(query, params);

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (err) {
    console.error("❌ Error fetching orders:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error while fetching orders.",
    });
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

    // Fetch order + related details (only one query)
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
        o.preview_url,   -- ✅ Added single representative preview URL
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

    const parseJsonArray = (jsonString) => {
      if (typeof jsonString === 'string') {
        try {
          return JSON.parse(jsonString);
        } catch (e) {
          console.warn("Could not parse JSON string:", e);
        }
      }
      return jsonString || [];
    };

    const cartIds = order.cart_id;
    let cartItems = [];
    for (i=0; i<cartIds.length;i++){
      const [res] = await promiseConn.query("SELECT * FROM cart_items where id=?",[cartIds[i]]);
      cartItems.push(res)
    }
    

    const customizationIds = order.customizations_id; 
    let customizations = [];
    for (i = 0; i < customizationIds.length; i++) {
    const query = `
        SELECT
            c.id AS customization_id,
            c.user_id,
            c.preview_image_url,
            -- Product Variant Details
            pv.id AS variant_id,
            pv.color AS variant_color,
            p.title AS product_title,
            p.sku AS product_sku,
            -- Logo Variant Details
            lv.id AS logo_variant_id,
            lv.color AS logo_color,
            lv.url AS logo_image_url,
            -- Placement Details
            lp.id AS placement_id,
            lp.name AS placement_name,
            lp.view AS placement_view
        FROM
            customizations c
        LEFT JOIN product_variants pv ON c.product_variant_id = pv.id
        LEFT JOIN products p ON pv.product_id = p.id
        LEFT JOIN logo_variants lv ON c.logo_variant_id = lv.id
        LEFT JOIN logo_placements lp ON c.placement_id = lp.id
        WHERE
            c.id = ?
    `;
    const [custres] = await promiseConn.query(query, [customizationIds[i]]);
    customizations.push(custres[0]);
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
        // Convert JSON strings to arrays for the client
        cart_ids: parseJsonArray(order.cart_id),
        customizations_ids: parseJsonArray(order.customizations_id),
        cartItems: cartItems,
        customizations: customizations,
        // Representative preview image (from the first item)
        preview_url: order.preview_url, 
        
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
    console.error("Error fetching simple order details:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});


//order-notes
router.get("/:id/order-notes", authenticateToken, async (req,res)=>{
  try{
    const {id} = req.params;
    const getNotes = "SELECT note, created_at FROM order_notes WHERE id=?";
    const [res] = await promiseConn.query(getNotes,[id]);
    if(res.length === 0){
      return res.status(404).json({message:"No messages yet"});
    }
    return res.status(200).json({res});
  }
  catch (err) {
    console.error("❌ Error fetching order notes:", err);
    res.status(500).json({ success: false, message: "Server error while fetching order notes." });
  }
})


//update order (status/Notes)
router.patch("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body;
  const requester = req.user;

  if (requester.role !== "Super Admin") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Only Super Admins can update orders.",
    });
  }

  const validStatuses = [
    "Pending",
    "Processing",
    "Shipped",
    "Delivered",
    "Cancelled",
    "Returned",
  ];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid status provided.",
    });
  }

  let conn;
  try {
    conn = await promiseConn.getConnection();
    await conn.beginTransaction();

    const [existingOrder] = await conn.query(
      `SELECT o.id, o.status, o.total_amount, o.payment_method,
              u.f_name, u.l_name, u.email
       FROM orders o
       JOIN users u ON o.user_id = u.id
       WHERE o.id = ?`,
      [id]
    );

    if (existingOrder.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    const order = existingOrder[0];

    // 🧾 Update status
    if (status) {
      await conn.query("UPDATE orders SET status = ? WHERE id = ?", [
        status,
        id,
      ]);
    }

    // 🗒️ Add note if provided
    if (note && note.trim() !== "") {
      await conn.query("INSERT INTO order_notes (order_id, note) VALUES (?, ?)", [
        id,
        note,
      ]);
    }

    await conn.commit();

    // 🧩 Fetch updated notes
    const [notes] = await conn.query(
      "SELECT id, note, created_at FROM order_notes WHERE order_id = ? ORDER BY created_at DESC",
      [id]
    );

    // 📧 Build email content
    let emailHtml = `
      <h2>Order Update - Neil Prints</h2>
      <p>Hi ${order.f_name},</p>
      <p>Your order <b>${id}</b> has been updated.</p>
    `;

    if (status) {
      emailHtml += `
        <p><b>New Status:</b> ${status}</p>
      `;
    }

    if (note && note.trim() !== "") {
      emailHtml += `
        <p><b>Admin Note:</b></p>
        <blockquote style="border-left:4px solid #007bff;padding-left:8px;color:#555;">
          ${note}
        </blockquote>
      `;
    }

    // ✉️ Send email
    await sendEmail(
      order.email,
      `Order Update - ${id} (${status || "Note Added"})`,
      emailHtml
    );

    return res.status(200).json({
      success: true,
      message: "Order updated successfully and email sent.",
      data: {
        order: {
          id,
          status: status || order.status,
          updated_at: new Date(),
        },
        notes,
      },
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("❌ Error updating order:", err);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error while updating order.",
      error: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});




module.exports = router;
