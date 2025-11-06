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
  const conn = await promiseConn.getConnection();
  try {
    const createdAt = getCurrentMysqlDatetime();
    const { title, category_id, org_id } = req.body; // updated
    const user = req.user;

    // ✅ Required fields check
    if (!title || !category_id) {
      return res.status(400).json({
        message: "Both 'title' and 'category_id' are required.",
      });
    }

    // ✅ Determine which org_id to use
    let orgIdValue = null;

    if (user.role === "Super Admin") {
      // Super Admin can assign to any org or leave null
      orgIdValue = org_id || null;
    } else {
      // Non–Super Admins can only create for their own org
      if (!org_id) {
        return res.status(400).json({
          message: "'org_id' is required for non–Super Admin users.",
        });
      }

      if (String(org_id) !== String(user.org_id)) {
        return res.status(403).json({
          message: "You are not authorized to create sub-categories for another organization.",
        });
      }

      orgIdValue = user.org_id; // ✅ force user's org_id
    }

    // ✅ Check for duplicate sub-category
    const [existing] = await conn.query(
      `SELECT id 
       FROM sub_categories 
       WHERE title = ? 
         AND category_id = ? 
         AND (
           (org_id IS NULL AND ? IS NULL) OR org_id = ?
         )`,
      [title, category_id, orgIdValue, orgIdValue]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: `Sub-category '${title}' already exists in this category.`,
      });
    }

    // ✅ Insert the new sub-category
    const [insertResult] = await conn.query(
      "INSERT INTO sub_categories (title, category_id, org_id, created_at) VALUES (?, ?, ?, ?)",
      [title, category_id, orgIdValue, createdAt]
    );

    if (insertResult.affectedRows === 0) {
      return res.status(400).json({ message: "Unable to add sub-category." });
    }

    res.status(201).json({
      message: "Sub-category added successfully.",
      data: {
        id: insertResult.insertId,
        title,
        category_id,
        org_id: orgIdValue,
      },
    });
  } catch (err) {
    console.error("❌ Error in POST /subcategories/new:", err);
    res.status(500).json({
      message: "Internal Server Error",
      error: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});


/* -------------------------------------------------------------------------- */
/* 📋 GET ALL SUB-CATEGORIES */
/* -------------------------------------------------------------------------- */
route.get("/all", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { title, category_id } = req.query; // filters
    const conditions = [];
    const params = [];

    // Filter by sub-category title
    if (title) {
      conditions.push("sc.title LIKE ?");
      params.push(`%${title}%`);
    }

    // Filter by category
    if (category_id) {
      conditions.push("sc.category_id = ?");
      params.push(category_id);
    }

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    // Join with categories and organizations to get titles
    const query = `
      SELECT 
        sc.id,
        sc.title,
        sc.category_id,
        c.title AS category_title,
        sc.org_id,
        o.title AS org_title,
        sc.created_at
      FROM sub_categories sc
      JOIN categories c ON sc.category_id = c.id
      LEFT JOIN organizations o ON sc.org_id = o.id
      ${whereClause}
      ORDER BY sc.created_at DESC
    `;

    const [rows] = await conn.query(query, params);

    if (!rows.length) {
      return res.status(404).json({ message: "No sub-categories found." });
    }

    res.status(200).json({ subCategories: rows });
  } catch (err) {
    console.error("❌ Error in GET /sub-categories/all:", err);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

/* -------------------------------------------------------------------------- */
/* 🔍 GET SUB-CATEGORY BY ID */
/* -------------------------------------------------------------------------- */
route.get("/:id", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        sc.id,
        sc.title,
        sc.category_id,
        c.title AS category_title,
        sc.org_id,
        o.title AS org_title,
        sc.created_at
      FROM sub_categories sc
      JOIN categories c ON sc.category_id = c.id
      LEFT JOIN organizations o ON sc.org_id = o.id
      WHERE sc.id = ?
    `;

    const [rows] = await conn.query(query, [id]);

    if (!rows.length) {
      return res.status(404).json({ message: "Sub-category not found." });
    }

    res.status(200).json({ subCategory: rows[0] });
  } catch (err) {
    console.error("❌ Error in GET /subcategories/:id:", err);
    res.status(500).json({ message: "Internal Server Error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});


/* -------------------------------------------------------------------------- */
/* 🗑️ DELETE SUB-CATEGORY */
/* -------------------------------------------------------------------------- */
route.delete("/:id", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { id } = req.params;
    const user = req.user;

    // Fetch sub-category first to check org ownership
    const [rows] = await conn.query(
      "SELECT org_id FROM sub_categories WHERE id = ?",
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Sub-category not found." });
    }

    const subCategory = rows[0];

    // Only allow deletion if:
    // - Super Admin, or
    // - Non-Super Admin deleting their own org's sub-category
    if (user.role !== "Super Admin" && String(subCategory.org_id) !== String(user.org_id)) {
      return res.status(403).json({
        message: "You are not authorized to delete this sub-category.",
      });
    }

    // Perform deletion
    const [result] = await conn.query(
      "DELETE FROM sub_categories WHERE id = ?",
      [id]
    );

    res.status(200).json({
      success: true,
      message: "Sub-category deleted successfully.",
      id,
    });
  } catch (err) {
    console.error("❌ Error in DELETE /subcategories/:id:", err);
    res.status(500).json({
      message: "Internal Server Error",
      error: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});


module.exports = route;
