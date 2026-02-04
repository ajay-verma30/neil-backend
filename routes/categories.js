const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const Authtoken = require("../Auth/tokenAuthentication");
const pool = mysqlconnect();
const promisePool = pool.promise();

const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const authorizeRoles =
  (...allowedRoles) =>
  (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };

//new category
route.post(
  "/new",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();
      const { title, org_id } = req.body;
      const requester = req.user; 

      if (!title) {
        return res.status(400).json({ message: "Title is required" });
      }
      let targetOrg;
      if (requester.role === "Super Admin") {
        targetOrg = org_id || null;
      } else {
        targetOrg = requester.org_id;
      }
      const getCategory = "SELECT title FROM categories WHERE org_id <=> ? AND title = ?";
      const [rows] = await conn.query(getCategory, [targetOrg, title]);      
      if (rows.length > 0) {
        return res.status(400).json({ message: "Category already exists for this organization" });
      }
      const created_by = requester.id;
      const addCategory = "INSERT INTO categories(title, org_id, created_by) VALUES (?, ?, ?)";
      const [insertResult] = await conn.query(addCategory, [
        title,
        targetOrg,
        created_by,
      ]);
      await conn.commit();
      return res.status(201).json({ message: "Category Added", data: insertResult.insertId });
    } catch (e) {
      if (conn) await conn.rollback();
      return res.status(500).json({ message: "Internal Server Error", error: e.message });
    } finally {
      if (conn) conn.release();
    }
  }
);

// Get all categories
route.get(
  "/all",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
      const requester = req.user;
      const { title, start_date, end_date } = req.query;
      let query = `
        SELECT 
          c.id, 
          c.title, 
          c.created_by, 
          c.created_at, 
          c.org_id,
          o.title AS organization
        FROM categories c
        LEFT JOIN organizations o ON c.org_id = o.id
      `;
      const conditions = [];
      const params = [];
      if (requester.role === "Super Admin") {
        if (req.query.org_id) {
          conditions.push("c.org_id = ?");
          params.push(req.query.org_id);
        }
      } else {
        conditions.push("(c.org_id = ? OR c.org_id IS NULL)");
        params.push(requester.org_id);
      }
      if (title) {
        conditions.push("c.title LIKE ?");
        params.push(`%${title}%`);
      }
      if (start_date && end_date) {
        conditions.push("DATE(c.created_at) BETWEEN ? AND ?");
        params.push(start_date, end_date);
      }
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY c.created_at DESC";
      const [rows] = await conn.query(query, params);
      return res.status(200).json({ success: true, categories: rows });
    } catch (e) {
      console.error("❌ Error fetching categories:", e);
      return res.status(500).json({ success: false, message: "Internal Server Error" });
    } finally {
      if (conn) conn.release();
    }
  }
);

//Update Category
route.patch(
  "/update/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();
      const categoryId = req.params.id;
      const { title } = req.body;
      const requester = req.user;
      const [existingRows] = await conn.query(
        "SELECT * FROM categories WHERE id=?",
        [categoryId]
      );
      if (existingRows.length === 0) {
        return res.status(404).json({ message: "Category not found" });
      }
      const category = existingRows[0];
      if (requester.role !== "Super Admin") {
        if (category.org_id !== requester.org_id) {
          return res.status(403).json({ 
            message: "You are not authorized to update categories from another organization." 
          });
        }
      }
      if (title) {
        const checkDuplicateQuery =
          "SELECT id FROM categories WHERE title=? AND org_id <=> ? AND id<>?";
        const [dupRows] = await conn.query(checkDuplicateQuery, [
          title,
          category.org_id,
          categoryId,
        ]);
        if (dupRows.length > 0) {
          return res.status(400).json({
            message: "Category with this title already exists for this organization",
          });
        }
      }
      const fields = [];
      const values = [];
      if (title !== undefined) {
        fields.push("title=?");
        values.push(title);
      }
      if (requester.role === "Super Admin" && req.body.org_id !== undefined) {
        fields.push("org_id=?");
        values.push(req.body.org_id || null);
      }
      if (fields.length === 0) {
        return res.status(400).json({ message: "No fields provided to update" });
      }
      values.push(categoryId);
      const updateQuery = `UPDATE categories SET ${fields.join(", ")} WHERE id=?`;      
      const [updateResult] = await conn.query(updateQuery, values);      
      await conn.commit();
      return res.status(200).json({ message: "Category updated successfully" });
    } catch (e) {
      if (conn) await conn.rollback();
      return res.status(500).json({ message: "Internal Server Error", error: e.message });
    } finally {
      if (conn) conn.release();
    }
  }
);

// Delete a category
route.delete(
  "/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
      const { id } = req.params;
      const requester = req.user;
      if (!id) {
        return res.status(400).json({ success: false, message: "Category ID is required" });
      }
      const [existing] = await conn.query(
        "SELECT id, org_id FROM categories WHERE id = ?",
        [id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: "Category not found" });
      }
      const category = existing[0];
      if (requester.role !== "Super Admin") {
        if (category.org_id !== requester.org_id) {
          return res.status(403).json({
            success: false,
            message: "You are not authorized to delete categories from another organization.",
          });
        }
      }
      const [deleteResult] = await conn.query("DELETE FROM categories WHERE id = ?", [id]);
      if (deleteResult.affectedRows !== 1) {
        return res.status(400).json({
          success: false,
          message: "Unable to delete category at this moment",
        });
      }
      return res.status(200).json({ success: true, message: "Category deleted successfully" });
    } catch (e) {
      console.error("❌ Error deleting category:", e);
      return res.status(500).json({ success: false, message: "Internal Server Error" });
    } finally {
      if (conn) conn.release();
    }
  }
);

module.exports = route;
