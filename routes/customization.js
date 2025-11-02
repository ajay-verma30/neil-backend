const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise();
const Authtoken = require("../Auth/tokenAuthentication");
const multer = require("multer");
const cloudinary = require("./cloudinary");
const streamifier = require("streamifier");

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
// Multer (Memory Storage for Cloudinary)
// =====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // Max 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/svg+xml", "image/png", "image/jpeg"];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed (SVG, PNG, JPG)!"), false);
  },
});

// =====================
// Helper: Upload Buffer to Cloudinary
// =====================
const uploadToCloudinary = (buffer, folder) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });

// =====================
// POST /new - Create Customization
// =====================
route.post("/new", Authtoken, upload.single("preview"), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();

    const { user_id, product_variant_id, logo_variant_id, placement_id } = req.body;

    if (!user_id || !product_variant_id || !logo_variant_id || !placement_id) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    let previewUrl = null;
    if (req.file && req.file.buffer) {
      previewUrl = await uploadToCloudinary(req.file.buffer, "customizations/previews");
    }

    const id = nanoid(10);
    await conn.query(
      `
      INSERT INTO customizations 
      (id, user_id, product_variant_id, logo_variant_id, placement_id, preview_image_url)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, user_id, product_variant_id, logo_variant_id, placement_id, previewUrl]
    );

    return res.status(201).json({
      message: "Customization created successfully.",
      customization: {
        id,
        user_id,
        product_variant_id,
        logo_variant_id,
        placement_id,
        preview_image_url: previewUrl,
      },
    });
  } catch (error) {
    console.error("❌ Error in /customizations/new:", error);
    return res.status(500).json({
      message: "Server error while creating customization.",
      error: error.sqlMessage || error.message,
    });
  } finally {
    if (conn) conn.release();
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

// =====================
// DELETE /:id - Delete Customization
// =====================
route.delete("/:id", Authtoken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const { id } = req.params;

    // Find the customization
    const [rows] = await conn.query("SELECT * FROM customizations WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ message: "Customization not found." });
    }

    const customization = rows[0];

    // Delete preview from Cloudinary
    if (customization.preview_image_url) {
      try {
        const urlParts = customization.preview_image_url.split("/");
        const folderAndFile = urlParts.slice(-2).join("/"); // e.g. "customizations/abc123.jpg"
        const publicId = folderAndFile.split(".")[0]; // remove extension
        await cloudinary.uploader.destroy(publicId);
      } catch (cloudErr) {
        console.warn("⚠️ Failed to delete Cloudinary preview:", cloudErr.message);
      }
    }

    // Delete DB record
    await conn.query("DELETE FROM customizations WHERE id = ?", [id]);

    return res.status(200).json({ message: "✅ Customization deleted successfully." });
  } catch (error) {
    console.error("❌ Error deleting customization:", error);
    return res.status(500).json({
      message: "Server error while deleting customization.",
      error: error.sqlMessage || error.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = route;
