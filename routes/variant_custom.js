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
  authorizeRoles('Super Admin','Admin','Manager'),
  async (req, res) => {
    try {
      const {
        variant_id,
        logo_id,
        logo_variant_id,
        name,       
        position_x,
        position_y,
        width,
        height,
        z_index
      } = req.body;

      const created_by = req.user.id; 
      if (!variant_id || !logo_variant_id || !logo_id || !name) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const sql = `
        INSERT INTO variant_logo_positions 
        (variant_id, logo_id, logo_variant_id, name, position_x, position_y, width, height, z_index, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await pool.query(sql, [
        variant_id,
        logo_id,
        logo_variant_id,
        name,
        position_x ?? 0,
        position_y ?? 0,
        width ?? 100,
        height ?? 100,
        z_index ?? 1,
        created_by
      ]);

      res.json({ message: "Placement saved successfully" });

    } catch (err) {
      console.error(err);
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
