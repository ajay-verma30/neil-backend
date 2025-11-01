const express = require("express");
const route = express.Router();
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise(); // ✅ use pooled promise connection
const authenticateToken = require("../Auth/tokenAuthentication");

/**
 * 🏠 Add a new address
 */
route.post("/new-address", authenticateToken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection(); // ✅ Get a connection from pool
    const user_id = req.user.id;

    const {
      type,
      address_line_1,
      address_line_2,
      city,
      state,
      postal_code,
      country,
      is_default,
    } = req.body;

    if (
      !type ||
      !address_line_1 ||
      !city ||
      !state ||
      !postal_code ||
      !country ||
      typeof is_default === "undefined"
    ) {
      return res.status(400).json({ message: "All fields are compulsory" });
    }

    const insertQuery = `
      INSERT INTO addresses (
        user_id, type, address_line1, address_line2,
        city, state, postal_code, country, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await conn.query(insertQuery, [
      user_id,
      type,
      address_line_1,
      address_line_2 || null,
      city,
      state,
      postal_code,
      country,
      is_default,
    ]);

    if (result.affectedRows !== 1) {
      return res
        .status(400)
        .json({ message: "Unable to save the address at this moment" });
    }

    return res.status(201).json({ message: "Address saved successfully" });
  } catch (error) {
    console.error("❌ Error saving address:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (conn) conn.release(); // ✅ Always release connection
  }
});

/**
 * 📦 Get all addresses for logged-in user
 */
route.get("/my-address", authenticateToken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const user_id = req.user.id;

    const [addresses] = await conn.query(
      "SELECT * FROM addresses WHERE user_id = ?",
      [user_id]
    );

    if (addresses.length === 0) {
      return res.status(404).json({ message: "No addresses found for this user." });
    }

    return res.status(200).json({ addresses });
  } catch (error) {
    console.error("❌ Error fetching addresses:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * ✏️ Edit an existing address
 */
route.put("/edit-address/:id", authenticateToken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const user_id = req.user.id;
    const address_id = req.params.id;

    const {
      type,
      address_line_1,
      address_line_2,
      city,
      state,
      postal_code,
      country,
      is_default,
    } = req.body;

    if (
      !type ||
      !address_line_1 ||
      !city ||
      !state ||
      !postal_code ||
      !country ||
      typeof is_default === "undefined"
    ) {
      return res.status(400).json({ message: "All fields are compulsory" });
    }

    const [existing] = await conn.query(
      "SELECT * FROM addresses WHERE id = ? AND user_id = ?",
      [address_id, user_id]
    );

    if (existing.length === 0) {
      return res.status(403).json({
        message: "You are not authorized to edit this address.",
      });
    }

    const updateQuery = `
      UPDATE addresses
      SET 
        type = ?, 
        address_line1 = ?, 
        address_line2 = ?, 
        city = ?, 
        state = ?, 
        postal_code = ?, 
        country = ?, 
        is_default = ?, 
        updated_at = NOW()
      WHERE id = ? AND user_id = ?
    `;

    const [result] = await conn.query(updateQuery, [
      type,
      address_line_1,
      address_line_2 || null,
      city,
      state,
      postal_code,
      country,
      is_default,
      address_id,
      user_id,
    ]);

    if (result.affectedRows === 0) {
      return res.status(400).json({ message: "Failed to update address." });
    }

    return res.status(200).json({ message: "Address updated successfully." });
  } catch (error) {
    console.error("❌ Error updating address:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * 🗑️ Delete an address
 */
route.delete("/delete-address/:id", authenticateToken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const user_id = req.user.id;
    const address_id = req.params.id;

    const [existing] = await conn.query(
      "SELECT * FROM addresses WHERE id = ? AND user_id = ?",
      [address_id, user_id]
    );

    if (existing.length === 0) {
      return res.status(403).json({
        message: "You are not authorized to delete this address or it does not exist.",
      });
    }

    const [result] = await conn.query(
      "DELETE FROM addresses WHERE id = ? AND user_id = ?",
      [address_id, user_id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ message: "Failed to delete address." });
    }

    return res.status(200).json({ message: "Address deleted successfully." });
  } catch (error) {
    console.error("❌ Error deleting address:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = route;
