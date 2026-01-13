const express = require("express");
const router = express.Router();
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise();
const Authtoken = require("../Auth/tokenAuthentication");

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied." });
    }
    next();
  };
};



router.post(
  "/new",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    try {
      const {
        variant_id,
        logo_id,
        logo_variant_id,
        name,
        type, // <--- Naya field 'type' yahan add kiya
        position_x_percent,
        position_y_percent,
        width_percent,
        height_percent,
        z_index,
      } = req.body;

      const created_by = req.user.id;

      // Validation (ab 'type' bhi mandatory hai)
      if (
        !variant_id ||
        !logo_variant_id ||
        !logo_id ||
        !name ||
        !type || // <--- Type check add kiya
        position_x_percent == null ||
        position_y_percent == null ||
        width_percent == null ||
        height_percent == null
      ) {
        return res.status(400).json({ error: "Missing required fields (including type)" });
      }

      // Default values if percentages are out of range
      const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

      const xPercent = clamp(Number(position_x_percent), 0, 100);
      const yPercent = clamp(Number(position_y_percent), 0, 100);
      const wPercent = clamp(Number(width_percent), 0, 100);
      const hPercent = clamp(Number(height_percent), 0, 100);
      const z = z_index ?? 1;

      // SQL Query mein 'type' column aur value add ki gayi hai
      const sql = `
        INSERT INTO variant_logo_positions 
        (variant_id, logo_id, logo_variant_id, name, type, 
         position_x_percent, position_y_percent, width_percent, height_percent, 
         z_index, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await pool.query(sql, [
        variant_id,
        logo_id,
        logo_variant_id,
        name,
        type, // <--- Value pass ki gayi
        xPercent,
        yPercent,
        wPercent,
        hPercent,
        z,
        created_by,
      ]);

      res.json({ message: "Placement saved successfully with type: " + type });
    } catch (err) {
      console.error("❌ Error saving placement:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);



router.delete(
  "/:id",
  Authtoken,
  authorizeRoles('Super Admin','Admin','Manager'),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: "Missing placement ID" });
      }

      // Check if placement exists
      const [rows] = await pool.query(
        "SELECT id FROM variant_logo_positions WHERE id = ?",
        [id]
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Placement not found" });
      }

      // Delete placement
      await pool.query(
        "DELETE FROM variant_logo_positions WHERE id = ?",
        [id]
      );

      res.json({ message: "Placement deleted successfully" });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);


module.exports = router;
