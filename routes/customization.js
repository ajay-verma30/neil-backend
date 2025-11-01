const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise(); // ✅ pooled connection
const Authtoken = require("../Auth/tokenAuthentication");
const fs = require("fs");
const multer = require("multer");
const path = require("path");

// =====================
// Helper Functions
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

// =====================
// Multer Configuration
// =====================
const uploadDir = path.join(__dirname, "../uploads/previews");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const extMap = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/svg+xml": ".svg",
    };
    const ext = extMap[file.mimetype] || path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${nanoid(8)}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/svg+xml", "image/png", "image/jpeg"];
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Only image files are allowed (SVG, PNG, JPG)!"), false);
};

const upload = multer({ storage, fileFilter });

// =====================
// POST /new - Create Customization
// =====================
route.post("/new", Authtoken, upload.single("preview"), async (req, res) => {
  let conn;
  let uploadedFilePath = null;

  try {
    conn = await pool.getConnection(); // ✅ pooled connection

    const { user_id, product_variant_id, logo_variant_id, placement_id } = req.body;

    if (!user_id || !product_variant_id || !logo_variant_id || !placement_id) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const id = nanoid(10);
    const previewPath = req.file ? `/uploads/previews/${req.file.filename}` : null;
    uploadedFilePath = req.file ? req.file.path : null;

    await conn.query(
      `
      INSERT INTO customizations 
      (id, user_id, product_variant_id, logo_variant_id, placement_id, preview_image_url)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, user_id, product_variant_id, logo_variant_id, placement_id, previewPath]
    );

    return res.status(201).json({
      message: "Customization created successfully.",
      customization: {
        id,
        user_id,
        product_variant_id,
        logo_variant_id,
        placement_id,
        preview_image_url: previewPath,
      },
    });
  } catch (error) {
    console.error("❌ Error in /customizations/new:", error);
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
    return res.status(500).json({
      message: "Server error while creating customization.",
      error: error.sqlMessage || error.message,
    });
  } finally {
    if (conn) conn.release(); // ✅ always release the connection
  }
});

// =====================
// GET /all-customizations - Role-based Listing
// =====================
route.get("/all-customizations", Authtoken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const user = req.user;

    let query = `
      SELECT 
        c.id,
        c.user_id,
        u.email AS user_email,
        u.org_id,
        og.title AS organization,
        c.product_variant_id,
        c.logo_variant_id,
        c.placement_id,
        c.preview_image_url,
        c.created_at
      FROM customizations c
      JOIN users u ON u.id = c.user_id
      JOIN organizations og ON og.id = u.org_id
    `;
    const params = [];

    if (isSuperAdmin(req)) {
      query += " ORDER BY c.created_at DESC";
    } else if (["Admin", "Manager"].includes(user.role)) {
      query += " WHERE u.org_id = ? ORDER BY c.created_at DESC";
      params.push(user.org_id);
    } else {
      query += " WHERE c.user_id = ? ORDER BY c.created_at DESC";
      params.push(user.id);
    }

    const [customizations] = await conn.query(query, params);

    return res.status(200).json({
      message: "Customizations fetched successfully.",
      customizations,
    });
  } catch (error) {
    console.error("❌ Error in /all-customizations:", error);
    return res.status(500).json({
      message: "Server error while fetching customizations.",
      error: error.sqlMessage || error.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = route;
