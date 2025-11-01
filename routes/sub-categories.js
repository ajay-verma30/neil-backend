// routes/subCategory.js
const express = require("express");
const route = express.Router();
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect(); // ✅ createPool()
const promiseConn = pool.promise();
const Authtoken = require("../Auth/tokenAuthentication");

// 🕒 MySQL DATETIME helper
const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

/* -------------------------------------------------------------------------- */
/* 🟢 CREATE SUB-CATEGORY */
/* -------------------------------------------------------------------------- */
route.post("/new", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection(); // ✅ get connection from pool
  try {
    const createdAt = getCurrentMysqlDatetime();
    const { title, category, org_id } = req.body;
    const user = req.user;

    if (!title || !category) {
      return res.status(400).json({
        message: "Both 'title' and 'category' are required.",
      });
    }

    // 🧠 Role-based org_id logic
    let orgIdValue = null;
    if (user.role === "Super Admin") {
      orgIdValue = org_id || null;
    } else {
      if (!org_id)
        return res
          .status(400)
          .json({ message: "'org_id' is required for non–Super Admin users." });
      orgIdValue = org_id;
    }

    // 🔍 Duplicate check (org-based)
    const [existing] = await conn.query(
      "SELECT id FROM sub_categories WHERE title=? AND category=? AND (org_id=? OR org_id IS NULL)",
      [title, category, orgIdValue]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: `Sub-category '${title}' already exists in '${category}'.`,
      });
    }

    // 🧩 Insert new sub-category
    const [insertResult] = await conn.query(
      "INSERT INTO sub_categories (title, category, org_id, created_at) VALUES (?, ?, ?, ?)",
      [title, category, orgIdValue, createdAt]
    );

    if (insertResult.affectedRows === 0) {
      return res.status(400).json({ message: "Unable to add sub-category." });
    }

    return res.status(201).json({
      message: "Sub-category added successfully.",
      data: { id: insertResult.insertId, title, category, org_id: orgIdValue },
    });
  } catch (err) {
    console.error("❌ Error in POST /subcategories/new:", err);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: err.message });
  } finally {
    conn.release(); // ✅ release connection back to pool
  }
});

/* -------------------------------------------------------------------------- */
/* 📋 GET ALL SUB-CATEGORIES */
/* -------------------------------------------------------------------------- */
route.get("/all", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { title, category } = req.query;
    const conditions = [];
    const params = [];

    if (title) {
      conditions.push("title LIKE ?");
      params.push(`%${title}%`);
    }
    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }

    const whereClause = conditions.length
      ? "WHERE " + conditions.join(" AND ")
      : "";

    const [rows] = await conn.query(
      `SELECT * FROM sub_categories ${whereClause} ORDER BY created_at DESC`,
      params
    );

    if (!rows.length)
      return res.status(404).json({ message: "No sub-categories found." });

    res.status(200).json({ subCategories: rows });
  } catch (err) {
    console.error("❌ Error in GET /subcategories/all:", err);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: err.message });
  } finally {
    conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* 🔍 GET SUB-CATEGORY BY ID */
/* -------------------------------------------------------------------------- */
route.get("/:id", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { id } = req.params;
    const [rows] = await conn.query(
      "SELECT * FROM sub_categories WHERE id = ?",
      [id]
    );

    if (!rows.length)
      return res.status(404).json({ message: "Sub-category not found." });

    res.status(200).json({ subCategory: rows[0] });
  } catch (err) {
    console.error("❌ Error in GET /subcategories/:id:", err);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: err.message });
  } finally {
    conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* 🗑️ DELETE SUB-CATEGORY */
/* -------------------------------------------------------------------------- */
route.delete("/:id", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { id } = req.params;

    const [result] = await conn.query(
      "DELETE FROM sub_categories WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Sub-category not found." });

    res
      .status(200)
      .json({ message: "Sub-category deleted successfully.", id });
  } catch (err) {
    console.error("❌ Error in DELETE /subcategories/:id:", err);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = route;
