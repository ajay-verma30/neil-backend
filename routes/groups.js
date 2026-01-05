const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise(); // ✅ pooled connection
const Authtoken = require("../Auth/tokenAuthentication");

// =====================
// Role helpers
// =====================
const isSuperAdmin = (req) => req.user?.role === "Super Admin";

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied." });
    }
    next();
  };
};

/* -----------------------------------
   🚀 CREATE NEW GROUP
----------------------------------- */
route.post(
  "/new",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    let conn;
    try {
      conn = await pool.getConnection(); // ✅

      const { title, org_id: requestedOrgId } = req.body;
      const user = req.user;

      if (!title || (!requestedOrgId && isSuperAdmin(req))) {
        return res
          .status(400)
          .json({ message: "Title and org_id are required." });
      }

      const orgId = isSuperAdmin(req) ? requestedOrgId : user.org_id;

      // Check if group already exists
      const [existing] = await conn.query(
        "SELECT * FROM user_groups WHERE title = ? AND org_id = ?",
        [title, orgId]
      );

      if (existing.length > 0) {
        return res
          .status(409)
          .json({ message: "Group already exists in this organization." });
      }

      const id = nanoid(8);
      const created_at = new Date();

      const [result] = await conn.query(
        "INSERT INTO user_groups (id, title, org_id, created_at) VALUES (?, ?, ?, ?)",
        [id, title, orgId, created_at]
      );

      if (result.affectedRows !== 1) {
        return res.status(500).json({ message: "Unable to create group." });
      }

      return res.status(201).json({
        message: "Group created successfully.",
        group: { id, title, org_id: orgId, created_at },
      });
    } catch (e) {
      console.error("❌ Create group error:", e);
      return res.status(500).json({
        message: "Internal Server Error",
        error: e.sqlMessage || e.message,
      });
    } finally {
      if (conn) conn.release(); // ✅ release back to pool
    }
  }
);

/* -----------------------------------
   📚 GET ALL GROUPS (Super Admin: all, Admin: own org)
----------------------------------- */
route.get(
  "/all",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    let conn;
    try {
      conn = await pool.getConnection();
      const user = req.user;
    
      const { search, org_id, start_date, end_date } = req.query;

      const whereConditions = [];
      const params = [];
      if (!isSuperAdmin(req)) {
        whereConditions.push("ug.org_id = ?");
        params.push(user.org_id);
      } else if (org_id) {
        whereConditions.push("ug.org_id = ?");
        params.push(org_id);
      }

      if (search) {
        whereConditions.push("ug.title LIKE ?");
        params.push(`%${search}%`);
      }

      if (start_date) {
        whereConditions.push("ug.created_at >= ?");
        params.push(start_date); 
      }

      if (end_date) {

        whereConditions.push("ug.created_at <= ?");
        params.push(`${end_date} 23:59:59`);
      }

      const whereClause = whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

      const [groups] = await conn.query(
        `
        SELECT 
          ug.id, 
          ug.title, 
          ug.created_at, 
          og.title AS organization
        FROM user_groups ug
        JOIN organizations og ON og.id = ug.org_id
        ${whereClause}
        ORDER BY ug.title ASC;
        `,
        params 
      );

      return res.status(200).json({ groups });
    } catch (e) {
      console.error("❌ Get all groups error:", e);
      return res.status(500).json({
        message: "Internal Server Error",
        error: e.sqlMessage || e.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);


// get users for the specific group

route.get('/group-members/:group_id', Authtoken, async (req, res) => {
    try {
        const { group_id } = req.params;
        const { role, org_id } = req.user; 
        const connection = await pool.getConnection();

        try {
            const query = `
SELECT 
    u.id AS user_id,
    CONCAT(u.f_name, ' ', u.l_name) AS full_name,
    u.email,
    u.role,
    ug.added_on,
    g.title AS group_name  -- Yeh add kiya
FROM user_group ug
JOIN users u ON ug.user_id = u.id
JOIN user_groups g ON ug.group_id = g.id
WHERE ug.group_id = ?
AND (? = 'Super Admin' OR g.org_id = ?);
            `;

            const [members] = await connection.query(query, [group_id, role, org_id]);
            if (members.length === 0) {
                return res.status(200).json({
                    success: true,
                    message: "No members found or access denied for this organization",
                    members: []
                });
            }

            res.status(200).json({
                success: true,
                count: members.length,
                members: members
            });

        } finally {
            connection.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* -----------------------------------
   🗑️ DELETE GROUP (Super Admin: any, Admin: own org)
----------------------------------- */
route.delete(
  "/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin"),
  async (req, res) => {
    let conn;
    try {
      conn = await pool.getConnection();
      const { id } = req.params;
      const user = req.user;

      const [group] = await conn.query("SELECT * FROM user_groups WHERE id = ?", [id]);
      if (!group.length)
        return res.status(404).json({ message: "Group not found." });

      if (!isSuperAdmin(req) && group[0].org_id !== user.org_id) {
        return res
          .status(403)
          .json({ message: "You cannot delete groups from other organizations." });
      }

      // Delete related user-group links first
      await conn.query("DELETE FROM user_group WHERE group_id = ?", [id]);

      // Then delete the group itself
      const [result] = await conn.query("DELETE FROM user_groups WHERE id = ?", [id]);

      if (result.affectedRows === 0)
        return res.status(404).json({ message: "No group deleted." });

      return res.status(200).json({ message: "Group deleted successfully." });
    } catch (e) {
      console.error("❌ Delete group error:", e);
      return res.status(500).json({
        message: "Internal Server Error",
        error: e.sqlMessage || e.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);



/* -----------------------------------
   🗑️ DELETE GROUP (Super Admin: any, Admin: own org)
----------------------------------- */
route.delete(
  "/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin"),
  async (req, res) => {
    let conn;
    try {
      conn = await pool.getConnection();
      const { id } = req.params;
      const user = req.user;
      const [group] = await conn.query("SELECT * FROM user_groups WHERE id = ?", [id]);
      if (!group.length) {
        return res.status(404).json({ message: "Group not found." });
      }
      if (!isSuperAdmin(req) && group[0].org_id !== user.org_id) {
        return res
          .status(403)
          .json({ message: "You cannot delete groups from other organizations." });
      }
      await conn.beginTransaction();

      try {
        await conn.query("DELETE FROM user_group WHERE group_id = ?", [id]);
        const [result] = await conn.query("DELETE FROM user_groups WHERE id = ?", [id]);

        if (result.affectedRows === 0) {
          throw new Error("Deletion failed at the final step.");
        }

        await conn.commit();        
        return res.status(200).json({ 
          success: true,
          message: "Group and its member associations deleted successfully." 
        });

      } catch (err) {
        await conn.rollback();
        throw err;
      }

    } catch (e) {
      console.error("❌ Delete group error:", e);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: e.sqlMessage || e.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);

module.exports = route;
