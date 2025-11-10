const express = require("express");
const route = express.Router();
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect(); 
const promiseConn = pool.promise();
const Authtoken = require("../Auth/tokenAuthentication");


route.post('/categories', Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();

  try {
    const { orgId } = req.body;

    if (!orgId) {
      return res.status(400).json({ message: "Missing required field: orgId" });
    }

    const [rows] = await conn.query(
      `
      SELECT 
        c.id AS category_id,
        c.title AS category_title,
        sc.id AS subcategory_id,
        sc.title AS subcategory_title
      FROM categories c
      LEFT JOIN sub_categories sc ON sc.category_id = c.id
      WHERE c.org_id = ? OR c.org_id IS NULL
      ORDER BY c.title, sc.title;
      `,
      [orgId]
    );

    const categories = {};

    rows.forEach((row) => {
      if (!categories[row.category_id]) {
        categories[row.category_id] = {
          id: row.category_id,
          title: row.category_title,
          subcategories: [],
        };
      }
      if (row.subcategory_id) {
        categories[row.category_id].subcategories.push({
          id: row.subcategory_id,
          title: row.subcategory_title,
        });
      }
    });

    res.status(200).json({
      success: true,
      categories: Object.values(categories),
    });

  } catch (err) {
    console.error("❌ Error in Getting categories:", err);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});


route.post("/sidebar/products", Authtoken, async (req, res) => {
  const conn = await promiseConn.getConnection();
  try {
    const { orgId, categoryId, subCategoryId } = req.body;

    let query = `
      SELECT 
        p.id, p.title, p.price, p.image_url, 
        c.title AS category_title, 
        sc.title AS subcategory_title
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.id
      WHERE p.org_id = ? 
    `;
    const params = [orgId];

    if (subCategoryId) {
      query += " AND p.sub_category_id = ?";
      params.push(subCategoryId);
    } else if (categoryId) {
      query += " AND p.category_id = ?";
      params.push(categoryId);
    }

    const [rows] = await conn.query(query, params);
    res.json({ success: true, products: rows });
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  } finally {
    if (conn) conn.release();
  }
});



module.exports = route;