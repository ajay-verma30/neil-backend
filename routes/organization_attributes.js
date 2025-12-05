const express = require('express');
const router = express.Router();
const mysqlconnect = require("../db/conn");
const Authtoken = require("../Auth/tokenAuthentication");
const multer = require("multer");
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId,
} = require("./cloudinary");
const streamifier = require("streamifier");


// ✅ Shared MySQL pool (one per app)
const pool = mysqlconnect();
const promisePool = pool.promise();


//multer config for image 
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, or WebP allowed"));
  },
}).any();


const authorizeRoles = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to perform this action.",
    });
  }
  next();
};

router.post(
  "/new-attribute",
  Authtoken, 
  authorizeRoles("Super Admin"), 
  upload, 
  async (req, res) => {
    const conn = await promisePool.getConnection();

    try {
      await conn.beginTransaction();
      const { org_id, org_context, text_color, background_color } = req.body;
      if (!org_id) {
        return res.status(400).json({ message: "org_id is required." });
      }

      const files = req.files || [];

      const logoFile = files.find((f) => f.fieldname === "logo");
      const orgImageFile = files.find((f) => f.fieldname === "org_image");

      let logoUrl = null;
      let orgImageUrl = null;

      if (logoFile) {
        logoUrl = await uploadToCloudinary(logoFile.buffer, "organization_logos");
      }

      if (orgImageFile) {
        orgImageUrl = await uploadToCloudinary(
          orgImageFile.buffer,
          "organization_images"
        );
      }

      const [existing] = await conn.query(
        "SELECT id FROM organization_attributes WHERE org_id = ?",
        [org_id]
      );
      if (existing.length === 0) {
        await conn.query(
          `INSERT INTO organization_attributes 
            (org_id, logo, org_context, org_image, text_color, background_color, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [
            org_id,
            logoUrl || null,
            org_context || null,
            orgImageUrl || null,
            text_color || null,
            background_color || null,
          ]
        );
      } else {
        await conn.query(
          `UPDATE organization_attributes SET 
              logo = COALESCE(?, logo),
              org_context = COALESCE(?, org_context),
              org_image = COALESCE(?, landing_image),
              text_color = COALESCE(?, text_color),
              background_color = COALESCE(?, background_color),
              updated_at = NOW()
           WHERE org_id = ?`,
          [
            logoUrl,
            org_context,
            orgImageUrl,
            text_color,
            background_color,
            org_id,
          ]
        );
      }
      await conn.commit();
      res.status(201).json({
        success: true,
        message: "Organization attributes saved successfully.",
        attributes: {
          org_id,
          logo: logoUrl,
          org_image: orgImageUrl,
          org_context,
          text_color,
          background_color,
        },
      });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error("❌ Error saving org attributes:", err);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: err.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);


// GET /organization/:org_id/attributes
router.get(
  "/organization/:org_id/attributes",
  Authtoken, // ensure authenticated
  authorizeRoles("Super Admin", "Admin", "Manager"), // restrict access
  async (req, res) => {
    const conn = await promisePool.getConnection();

    try {
      const { org_id } = req.params;

      if (!org_id)
        return res.status(400).json({ message: "org_id is required." });

      // Fetch attributes from DB
      const [rows] = await conn.query(
        "SELECT org_id, logo, org_image, org_context, text_color, background_color FROM organization_attributes WHERE org_id = ?",
        [org_id]
      );

      if (rows.length === 0)
        return res
          .status(404)
          .json({ message: "No attributes found for this organization." });

      res.status(200).json({ success: true, attributes: rows[0] });
    } catch (err) {
      console.error("❌ Error fetching org attributes:", err);
      res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: err.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);


// PATCH /organization/:org_id/attributes
router.patch(
  "/organization/:org_id/attributes",
  Authtoken,
  authorizeRoles("Super Admin"),
  upload, // Multer middleware for image uploads
  async (req, res) => {
    const conn = await promisePool.getConnection();

    try {
      await conn.beginTransaction();

      const { org_id } = req.params;
      const { org_context, text_color, background_color } = req.body;

      if (!org_id)
        return res.status(400).json({ message: "org_id is required." });

      // Extract uploaded files
      const files = req.files || [];
      const logoFile = files.find((f) => f.fieldname === "logo");
      const orgImageFile = files.find((f) => f.fieldname === "org_image");

      let logoUrl = null;
      let orgImageUrl = null;

      // Upload files to Cloudinary if provided
      if (logoFile) {
        logoUrl = await uploadToCloudinary(
          logoFile.buffer,
          "organization_logos"
        );
      }

      if (orgImageFile) {
        orgImageUrl = await uploadToCloudinary(
          orgImageFile.buffer,
          "organization_images"
        );
      }

      // Check if attributes exist
      const [existing] = await conn.query(
        "SELECT id FROM organization_attributes WHERE org_id = ?",
        [org_id]
      );

      if (existing.length === 0) {
        return res
          .status(404)
          .json({ message: "Organization attributes not found." });
      }

      // Update the attributes
      await conn.query(
        `UPDATE organization_attributes SET
            logo = COALESCE(?, logo),
            landing_image = COALESCE(?, landing_image),
            org_context = COALESCE(?, org_context),
            text_color = COALESCE(?, text_color),
            background_color = COALESCE(?, background_color),
            updated_at = NOW()
          WHERE org_id = ?`,
        [logoUrl, orgImageUrl, org_context, text_color, background_color, org_id]
      );

      await conn.commit();

      res.status(200).json({
        success: true,
        message: "Organization attributes updated successfully.",
        attributes: {
          org_id,
          logo: logoUrl,
          org_image: orgImageUrl,
          org_context,
          text_color,
          background_color,
        },
      });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error("❌ Error updating org attributes:", err);
      res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: err.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);


module.exports = router;