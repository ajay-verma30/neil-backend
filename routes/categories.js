const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const Authtoken = require("../Auth/tokenAuthentication");
const pool = mysqlconnect();
const promisePool = pool.promise();

const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Access denied" });
  }
  next();
};


//new category

route.post('/new', Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
        await conn.beginTransaction();

        const { title, org_id } = req.body;

        if (!title) {
            return res.status(400).json({ message: "Title is required" });
        }

        // Check if category already exists for this org
        const getCategory = "SELECT title FROM categories WHERE org_id=? AND title=?";
        const [rows] = await conn.query(getCategory, [org_id, title]);
        if (rows.length > 0) {
            return res.status(400).json({ message: "Category already exists for this organization" });
        }

        const created_by = req.user.id;
        const addCategory = "INSERT INTO categories(title, org_id, created_by) VALUES (?, ?, ?)";
        const [insertResult] = await conn.query(addCategory, [title, org_id, created_by]);

        if (insertResult.affectedRows !== 1) {
            return res.status(400).json({ message: "Unable to create category at this moment. Try again!" });
        }

        await conn.commit();
        return res.status(201).json({ message: "Category Added", data: insertResult.insertId });

    } catch (e) {
        if (conn) await conn.rollback();
        console.error("❌ Error creating category:", e);
        return res.status(500).json({ message: "Internal Server Error", error: e.message });
    } finally {
        if (conn) conn.release();
    }
});


//all -categories
// Get all categories
route.get('/all', Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
        const { org_id } = req.query; 

        let query = `
            SELECT 
                c.id, 
                c.title, 
                c.created_by, 
                c.created_at, 
                o.title AS organization 
            FROM categories c
            LEFT JOIN organizations o ON c.org_id = o.id
        `;
        const params = [];

        if (org_id) {
            query += " WHERE c.org_id = ?";
            params.push(org_id);
        }

        const [rows] = await conn.query(query, params);

        if (!rows.length) {
            return res.status(404).json({ success: false, message: "No categories found." });
        }

        return res.status(200).json({ success: true, categories: rows });

    } catch (e) {
        console.error("❌ Error fetching categories:", e);
        return res.status(500).json({ success: false, message: "Internal Server Error", error: e.message });
    } finally {
        if (conn) conn.release();
    }
});


//delete 
// Delete a category
route.delete('/:id', Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ success: false, message: "Category ID is required" });
        }
        const [existing] = await conn.query("SELECT id FROM categories WHERE id = ?", [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: "Category not found" });
        }
        const [deleteResult] = await conn.query("DELETE FROM categories WHERE id = ?", [id]);

        if (deleteResult.affectedRows !== 1) {
            return res.status(400).json({ success: false, message: "Unable to delete category at this moment" });
        }

        return res.status(200).json({ success: true, message: "Category deleted successfully" });

    } catch (e) {
        console.error("❌ Error deleting category:", e);
        return res.status(500).json({ success: false, message: "Internal Server Error", error: e.message });
    } finally {
        if (conn) conn.release();
    }
});


module.exports = route;