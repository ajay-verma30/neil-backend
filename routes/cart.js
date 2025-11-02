const express = require("express");
const route = express.Router();
const mysqlconnect = require("../db/conn");
const {nanoid} = require('nanoid');
const pool = mysqlconnect().promise(); 
const authenticateToken = require("../Auth/tokenAuthentication");


// -----------------------------------------------------
// 🛒 1️⃣ Add to Cart
// -----------------------------------------------------
route.post("/add", authenticateToken, async (req, res) => {
  try {
    const { user_id, product_id, title, image, quantity, sizes, total_price } = req.body;

    if (!user_id || !product_id || !title || !total_price) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const id = nanoid(10); 

    const [result] = await pool.query(
      `INSERT INTO cart_items 
        (id, user_id, product_id, title, image, quantity, sizes, total_price, ordered) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
      [
        id,
        user_id,
        product_id,
        title,
        image,
        quantity,
        JSON.stringify(sizes),
        total_price,
      ]
    );

    res.status(201).json({
      message: "✅ Item added to cart successfully.",
      cart_item_id: id,
    });
  } catch (err) {
    console.error("Error adding to cart:", err);
    res.status(500).json({ message: "❌ Failed to add to cart.", error: err.message });
  }
});

// -----------------------------------------------------
// 🧾 2️⃣ Get Cart Items for a User
// -----------------------------------------------------
route.get("/:user_id", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.params;

    const [rows] = await pool.query(
      `SELECT * FROM cart_items WHERE user_id = ? AND ordered = FALSE`,
      [user_id]
    );

    // parse sizes JSON for frontend
    const cart = rows.map(item => ({
      ...item,
      sizes: item.sizes ? JSON.parse(item.sizes) : {},
    }));

    res.status(200).json(cart);
  } catch (err) {
    console.error("Error fetching cart:", err);
    res.status(500).json({ message: "❌ Failed to fetch cart.", error: err.message });
  }
});

// -----------------------------------------------------
// ❌ 3️⃣ Remove Item from Cart
// -----------------------------------------------------
route.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `DELETE FROM cart_items WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Item not found in cart." });

    res.status(200).json({ message: "🗑️ Item removed from cart." });
  } catch (err) {
    console.error("Error removing item:", err);
    res.status(500).json({ message: "❌ Failed to remove item.", error: err.message });
  }
});

// -----------------------------------------------------
// ✅ 4️⃣ Checkout (Mark All User Items as Ordered)
// -----------------------------------------------------
route.post("/checkout/:user_id", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.params;

    const [result] = await pool.query(
      `UPDATE cart_items SET ordered = TRUE WHERE user_id = ? AND ordered = FALSE`,
      [user_id]
    );

    if (result.affectedRows === 0)
      return res.status(400).json({ message: "No items in cart to checkout." });

    res.status(200).json({ message: "🛍️ Checkout successful." });
  } catch (err) {
    console.error("Error during checkout:", err);
    res.status(500).json({ message: "❌ Checkout failed.", error: err.message });
  }
});

module.exports = route;


module.exports = route;
