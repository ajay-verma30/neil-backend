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

// router.post("/new", authenticateToken, async (req, res) => {
//   const connection = await pool.getConnection();
//   try {
//     const {
//       user_id,
//       org_id,
//       shipping_address_id,
//       billing_address_id,
//       payment_method = null,
//     } = req.body;

//     // ✅ Basic validations
//     if (!user_id || !org_id || !shipping_address_id || !billing_address_id) {
//       return res.status(400).json({ message: "Missing required fields." });
//     }

//     // ✅ Fetch cart items for the user
//     const [cartItems] = await connection.query(
//       `SELECT * FROM cart_items WHERE user_id = ? AND ordered = FALSE`,
//       [user_id]
//     );

//     if (!cartItems.length) {
//       return res.status(400).json({ message: "No items in cart." });
//     }

//     // ✅ Compute total
//     const totalAmount = cartItems
//       .reduce((sum, item) => sum + parseFloat(item.total_price || 0), 0)
//       .toFixed(2);

//     // ✅ Begin transaction
//     await connection.beginTransaction();

//     // ✅ Create order entry
//     const orderId = nanoid(12);
//     const orderBatchId = "ORD-" + Date.now();

//     await connection.query(
//       `INSERT INTO orders (
//         id, user_id, org_id, order_batch_id, 
//         shipping_address_id, billing_address_id, 
//         status, total_amount, payment_status, payment_method
//       ) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, 'Unpaid', ?)`,
//       [
//         orderId,
//         user_id,
//         org_id,
//         orderBatchId,
//         shipping_address_id,
//         billing_address_id,
//         totalAmount,
//         payment_method,
//       ]
//     );

//     // ✅ Insert all order items
//     for (const item of cartItems) {
//       const unitPrice = parseFloat(item.total_price) / (item.quantity || 1);

//       await connection.query(
//         `INSERT INTO order_items (
//           order_id, cart_item_id, customizations_id, 
//           product_title, image_url, unit_price, quantity, sizes
//         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           orderId,
//           item.id,
//           item.customizations_id,
//           item.title,
//           item.image,
//           unitPrice.toFixed(2),
//           item.quantity || 1,
//           JSON.stringify(item.sizes || {}),
//         ]
//       );
//     }

//     // ✅ Mark cart items as ordered
//     await connection.query(
//       `UPDATE cart_items SET ordered = TRUE WHERE user_id = ?`,
//       [user_id]
//     );

//     // ✅ Commit transaction
//     await connection.commit();

//     res.status(201).json({
//       success: true,
//       message: "Order created successfully.",
//       order_id: orderId,
//       order_batch_id: orderBatchId,
//       total: totalAmount,
//       items: cartItems.length,
//     });
//   } catch (error) {
//     console.error("❌ Order creation failed:", error);
//     await connection.rollback();
//     res
//       .status(500)
//       .json({ success: false, message: "Failed to create order.", error: error.message });
//   } finally {
//     connection.release();
//   }
// });


router.post("/new", authenticateToken, async(req,res)=>{
  const connection = await pool.getConnection();
  try{
    const id = nanoid(17);
    const {user_id} = req.body;
//const {user_id, org_id, shipping_address_id, billing_address_id} = req.body;
    // if(!user_id || !org_id || !shipping_address_id || !billing_address_id){
    //   return res.status(400).json({message:"Missing required fields"});
    // }

    const [cart_items] = await connection.query(`SELECT * FROM cart_items WHERE user_id = ? AND ordered = FALSE`,[user_id]);
    if(cart_items.length === 0){
      return res.status(400).json({message:"No items in the cart yet."});
    }
    return res.status(200).json({data: cart_items});
  }
  catch (error) {
    console.error("❌ Order creation failed:", error);
    await connection.rollback();
    res
      .status(500)
      .json({ success: false, message: "Failed to create order.", error: error.message });
  } finally {
    connection.release();
  }
})



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
        -- 🧾 Order info
        o.id AS order_id,
        o.status,
        o.total_amount,
        o.created_at AS order_date,
        o.user_id,
        o.shipping_address_id,
        o.billing_address_id,

        -- 👤 User info
        CONCAT(u.f_name, ' ', u.l_name) AS customer_name,
        u.email,
        u.contact,

        -- 🏢 Organization info
        org.id AS organization_id,
        org.title AS organization_name,

        -- 🛍️ Product + customization info
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

        -- 🖼️ Logo + placement info
        l.id AS logo_id,
        l.title AS logo_title,
        lv.id AS logo_variant_id,
        lv.color AS logo_color,
        lv.url AS logo_url,
        lp.id AS placement_id,
        lp.name AS placement_name,
        lp.view AS placement_view,

        -- 🏠 Shipping address
        sa.address_line1 AS shipping_address_line1,
        sa.address_line2 AS shipping_address_line2,
        sa.city AS shipping_city,
        sa.state AS shipping_state,
        sa.postal_code AS shipping_postal_code,
        sa.country AS shipping_country,

        -- 🧾 Billing address
        ba.address_line1 AS billing_address_line1,
        ba.address_line2 AS billing_address_line2,
        ba.city AS billing_city,
        ba.state AS billing_state,
        ba.postal_code AS billing_postal_code,
        ba.country AS billing_country

      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN organizations org ON u.org_id = org.id
      JOIN customizations c ON o.customizations_id = c.id
      JOIN product_variants pv ON c.product_variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      JOIN logo_variants lv ON c.logo_variant_id = lv.id
      JOIN logos l ON lv.logo_id = l.id
      JOIN logo_placements lp ON c.placement_id = lp.id
      LEFT JOIN addresses sa ON o.shipping_address_id = sa.id
      LEFT JOIN addresses ba ON o.billing_address_id = ba.id
      WHERE o.id = ?
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const order = rows[0];

    // ✅ Authorization check
    if (
      user.role !== "Super Admin" &&
      !(
        (["Admin", "Manager"].includes(user.role) && user.org_id === order.organization_id) ||
        (user.role === "User" && user.id === order.user_id)
      )
    ) {
      return res.status(403).json({ success: false, message: "Access denied to this order." });
    }

    // ✅ Restructure address data neatly
    const formattedOrder = {
      ...order,
      shipping_address: {
        address_line1: order.shipping_address_line1,
        address_line2: order.shipping_address_line2,
        city: order.shipping_city,
        state: order.shipping_state,
        postal_code: order.shipping_postal_code,
        country: order.shipping_country,
      },
      billing_address: {
        address_line1: order.billing_address_line1,
        address_line2: order.billing_address_line2,
        city: order.billing_city,
        state: order.billing_state,
        postal_code: order.billing_postal_code,
        country: order.billing_country,
      },
    };

    // ✅ Send response
    res.json({ success: true, order: formattedOrder });
  } catch (error) {
    console.error("❌ Error fetching order:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order.", error: error.message });
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
    res.status(500).json({ success: false, message: "Failed to update order." });
  }
});

module.exports = router;
