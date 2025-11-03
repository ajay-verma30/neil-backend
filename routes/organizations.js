// routes/organization.js
const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const Authtoken = require("../Auth/tokenAuthentication");
const bcrypt = require("bcryptjs");

// ✅ Shared MySQL pool (one per app)
const pool = mysqlconnect();
const promisePool = pool.promise();

// ✅ Role-based authorization middleware
const authorizeRoles = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to perform this action.",
    });
  }
  next();
};

// ✅ Create a new organization + default admin user
route.post("/new", async (req, res) => {
  const conn = await promisePool.getConnection();
  try {
    await conn.beginTransaction();

    const orgId = nanoid(5);
    const userID = nanoid(9);
    const { title, f_name, l_name, email, contact, password } = req.body;
    const createdAt = new Date();

    if (!title || !f_name || !l_name || !email || !contact || !password) {
      await conn.rollback();
      return res
        .status(400)
        .json({ success: false, message: "Please fill all required fields." });
    }

    await conn.query(
      "INSERT INTO organizations (id, title, created_at) VALUES (?, ?, ?)",
      [orgId, title, createdAt]
    );

    const role = "Admin";
    const hashpassword = await bcrypt.hash(password, 12);

    await conn.query(
      "INSERT INTO users (id, f_name, l_name, email, contact, hashpassword, role, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [userID, f_name, l_name, email, contact, hashpassword, role, orgId, createdAt]
    );

    await conn.query("UPDATE organizations SET default_admin = ? WHERE id = ?", [
      userID,
      orgId,
    ]);

    await conn.commit();

    res.status(201).json({
      success: true,
      message: "Organization and admin user created successfully.",
    });
  } catch (e) {
    console.error("❌ Error creating organization:", e);
    if (conn) await conn.rollback();
    res
      .status(500)
      .json({ success: false, message: "Internal Server Error", error: e.message });
  } finally {
    if (conn) conn.release();
  }
});

// ✅ Fetch all organizations (Super Admin only)
route.get("/all-organizations", Authtoken, authorizeRoles("Super Admin"), async (req, res) => {
  try {
    const [rows] = await promisePool.query("SELECT * FROM organizations");
    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "No organizations found." });
    }
    res.status(200).json({ success: true, organizations: rows });
  } catch (e) {
    console.error("❌ Error fetching organizations:", e);
    res
      .status(500)
      .json({ success: false, message: "Internal Server Error", error: e.message });
  }
});

// ✅ List organization titles (Super Admin only)
route.get("/organizations-list", Authtoken, authorizeRoles("Super Admin"), async (req, res) => {
  try {
    const [orgs] = await promisePool.query(
      "SELECT id, title FROM organizations ORDER BY title ASC"
    );
    res.status(200).json({ success: true, data: orgs });
  } catch (err) {
    console.error("❌ Error fetching organization list:", err);
    res.status(500).json({
      success: false,
      message: "Server error fetching organizations.",
    });
  }
});

// ✅ Get specific organization by ID
route.get("/:id", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id)
      return res
        .status(400)
        .json({ success: false, message: "Organization ID is required." });

    // Restrict Admin/Manager to their own org
    if (req.user.role !== "Super Admin" && req.user.org_id !== id) {
      return res
        .status(403)
        .json({ success: false, message: "Access denied for this organization." });
    }

    const [orgResult] = await promisePool.query(
      "SELECT * FROM organizations WHERE id = ?",
      [id]
    );
    if (!orgResult.length) {
      return res
        .status(404)
        .json({ success: false, message: "No organization found with this ID." });
    }

    const organization = orgResult[0];
    let adminDetails = null;

    if (organization.default_admin) {
      const [adminResult] = await promisePool.query(
        "SELECT id, f_name, l_name, email, contact, role, created_at FROM users WHERE id = ?",
        [organization.default_admin]
      );
      if (adminResult.length > 0) adminDetails = adminResult[0];
    }

    res.status(200).json({
      success: true,
      organization: { ...organization, admin: adminDetails },
    });
  } catch (e) {
    console.error("❌ Error fetching organization:", e);
    res
      .status(500)
      .json({ success: false, message: "Internal Server Error", error: e.message });
  }
});

// ✅ Update organization status (active/inactive)
route.patch("/:id/status", Authtoken, authorizeRoles("Super Admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (typeof status !== "boolean") {
      return res
        .status(400)
        .json({ success: false, message: "Status must be true or false." });
    }

    const [result] = await promisePool.query(
      "UPDATE organizations SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "No organization found with this ID." });
    }

    res.status(200).json({
      success: true,
      message: `Organization ${
        status ? "activated" : "deactivated"
      } successfully.`,
    });
  } catch (e) {
    console.error("❌ Error updating organization status:", e);
    res
      .status(500)
      .json({ success: false, message: "Internal Server Error", error: e.message });
  }
});

// ✅ Delete organization (Super Admin only)
route.delete("/:id", Authtoken, authorizeRoles("Super Admin"), async (req, res) => {
  const conn = await promisePool.getConnection();
  try {
    const { id } = req.params;
    if (!id) {
      conn.release();
      return res
        .status(400)
        .json({ success: false, message: "Organization ID required." });
    }

    await conn.beginTransaction();

    // ✅ 1. Delete product images
    await conn.query(`
      DELETE pi FROM product_images pi
      JOIN products p ON pi.product_id = p.id
      WHERE p.org_id = ?`, [id]);

    // ✅ 2. Delete product variants
    await conn.query(`
      DELETE pv FROM product_variants pv
      JOIN products p ON pv.product_id = p.id
      WHERE p.org_id = ?`, [id]);

    // ✅ 3. Delete customizations
    await conn.query(`
      DELETE c FROM customizations c
      JOIN product_variants pv ON c.product_variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      WHERE p.org_id = ?`, [id]);

    // ✅ 4. Delete logos
    await conn.query(`DELETE FROM logos WHERE org_id = ?`, [id]);

    // ✅ 5. Delete products
    await conn.query(`DELETE FROM products WHERE org_id = ?`, [id]);

    // ✅ 6. Delete orders
    await conn.query(`DELETE FROM orders WHERE org_id = ?`, [id]);

    // ✅ 7. Delete user_refresh_tokens
    await conn.query(`
      DELETE urt FROM user_refresh_tokens urt
      JOIN users u ON urt.user_id = u.id
      WHERE u.org_id = ?`, [id]);

    // ✅ 8. Delete password_reset_tokens
    await conn.query(`
      DELETE prt FROM password_reset_tokens prt
      JOIN users u ON prt.user_id = u.id
      WHERE u.org_id = ?`, [id]);

    // ✅ 9. Delete cart_items for all users in this org
    await conn.query(`
      DELETE ci FROM cart_items ci
      JOIN users u ON ci.user_id = u.id
      WHERE u.org_id = ?`, [id]);

    // ✅ 10. Delete addresses of users
    await conn.query(`
      DELETE a FROM addresses a
      JOIN users u ON a.user_id = u.id
      WHERE u.org_id = ?`, [id]);

      // ✅ Delete customizations created by users in this organization
await conn.query(`
  DELETE c FROM customizations c
  JOIN users u ON c.user_id = u.id
  WHERE u.org_id = ?`, 
  [id]
);

    // ✅ 11. Delete users
    await conn.query(`DELETE FROM users WHERE org_id = ?`, [id]);

    // ✅ 12. Finally delete the organization
    const [result] = await conn.query(`DELETE FROM organizations WHERE id = ?`, [id]);

    if (result.affectedRows === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    await conn.commit();
    res.status(200).json({
      success: true,
      message: "✅ Organization and all related data deleted successfully.",
    });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error deleting organization:", e);
    res.status(500).json({
      success: false,
      message: "Internal Server Error while deleting organization.",
      error: e.message,
    });
  } finally {
    conn.release();
  }
});



module.exports = route;
