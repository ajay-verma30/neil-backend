const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise();
const Authtoken = require("../Auth/tokenAuthentication");
const multer = require("multer");
const { cloudinary } = require("./cloudinary"); 
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
    // ✅ Accept blank type or octet-stream from html2canvas blob
    if (allowedTypes.includes(file.mimetype) || file.mimetype === "" || file.mimetype === "application/octet-stream") {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed (SVG, PNG, JPG)!"), false);
    }
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

    let { user_id, product_variant_id, logo_variant_ids, placement_ids } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "⚠️ User ID is required." });
    }

    // =====================
    // Parse JSON safely
    // =====================
    const parseJSON = (input) => {
      if (!input) return null;
      try {
        return typeof input === "string" ? JSON.parse(input) : input;
      } catch {
        return null;
      }
    };

    product_variant_id = parseJSON(product_variant_id);
    logo_variant_ids = parseJSON(logo_variant_ids);
    placement_ids = parseJSON(placement_ids);

    // =====================
    // Handle preview image
    // =====================
    let previewUrl = null;
    if (req.file && req.file.buffer) {
      previewUrl = await uploadToCloudinary(req.file.buffer, "customizations/previews");
    }

    const id = nanoid(10);

    // =====================
    // Insert into DB
    // =====================
    const sql = `
      INSERT INTO customizations 
      (id, user_id, product_variant_id, logo_variant_ids, placement_ids, preview_image_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const values = [
      id,
      user_id,
      product_variant_id ? JSON.stringify(product_variant_id) : null,
      logo_variant_ids ? JSON.stringify(logo_variant_ids) : null,
      placement_ids ? JSON.stringify(placement_ids) : null,
      previewUrl
    ];

    await conn.query(sql, values);

    return res.status(201).json({
      message: "✅ Customization created successfully.",
      customization: {
        id,
        user_id,
        product_variant_id,
        logo_variant_ids,
        placement_ids,
        preview_image_url: previewUrl
      }
    });
  } catch (error) {
    console.error("❌ Error in /customizations/new:", error.message, error.stack);
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
        c.logo_variant_ids,
        c.placement_ids,
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
    console.error("❌ Error in /all-customizations:", error.message, error.stack);
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
        const folderAndFile = urlParts.slice(-2).join("/"); // e.g. "customizations/previews/abc123.jpg"
        const fullPublicId = folderAndFile.split(".")[0];
        await cloudinary.uploader.destroy(fullPublicId);
      } catch (cloudErr) {
        console.warn("⚠️ Failed to delete Cloudinary preview:", cloudErr.message);
      }
    }

    // Delete DB record
    await conn.query("DELETE FROM customizations WHERE id = ?", [id]);

    return res.status(200).json({ message: "✅ Customization deleted successfully." });
  } catch (error) {
    console.error("❌ Error deleting customization:", error.message, error.stack);
    return res.status(500).json({
      message: "Server error while deleting customization.",
      error: error.sqlMessage || error.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = route;
