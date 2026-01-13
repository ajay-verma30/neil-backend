const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const fs = require("fs");
const path = require("path"); 
const streamifier = require("streamifier"); 
const multer = require("multer");
const mysqlconnect = require("../db/conn");
const { cloudinary } = require("./cloudinary");
const Authtoken = require("../Auth/tokenAuthentication");

const pool = mysqlconnect();
const promiseConn = pool.promise();

const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };
};

// ✅ Multer memory storage (no local files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, 
  fileFilter: (req, file, cb) => {
    const isSvg =
      file.mimetype === "image/svg+xml" &&
      file.originalname.toLowerCase().endsWith(".svg");
    const isPng =
      file.mimetype === "image/png" &&
      file.originalname.toLowerCase().endsWith(".png");

    if (isSvg || isPng) cb(null, true);
    else cb(new Error("Only SVG and PNG files are allowed!"), false);
  },
});


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


  // Add this helper function to your file
const getCloudinaryPublicId = (url) => {
  // Cloudinary URL format: .../v[version]/folder/public_id.png
  // This extracts 'folder/public_id'
  const parts = url.split('/');
  const folderAndId = parts.slice(parts.lastIndexOf('upload') + 2).join('/').split('.')[0];
  return folderAndId;
};

const deleteFromCloudinary = async (url) => {
  if (!url || !url.includes('cloudinary.com')) return;

  const publicId = getCloudinaryPublicId(url);
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    if (result.result !== 'ok' && result.result !== 'not found') {
      console.warn(`Cloudinary deletion warning for ${publicId}:`, result);
    }
  } catch (error) {
    console.error(`Error deleting file from Cloudinary: ${publicId}`, error);
    // You might choose to throw the error or just log it, as the DB transaction has already committed.
  }
};




const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user) => {
    req.user = err ? null : user;
    next();
  });
};
// =====================
// CREATE Logo
// =====================
route.post(
  "/new-logo",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  upload.array("logos"),
  async (req, res) => {
    try {
      const { title, colors, placements, org_id } = req.body;

      if (!req.files || req.files.length === 0)
        return res.status(400).json({ message: "SVG logo files are required." });
      if (!title || !colors)
        return res.status(400).json({ message: "Title and colors are required." });

      let finalOrgId = null;
      if (req.user.role === "Super Admin") {
        finalOrgId = org_id || null;
      } else {
        if (org_id && org_id !== req.user.org_id) {
          return res.status(403).json({
            message: "You are not authorized to create logo for this organization"
          });
        }
        finalOrgId = req.user.org_id;
      }

      const uploadPromises = req.files.map(file =>
        uploadToCloudinary(file.buffer, "logos")
      );
      const cloudinaryUrls = await Promise.all(uploadPromises);

      const logoId = nanoid(13);
      const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");

      const colorArray = JSON.parse(colors);
      const placementArray = placements ? JSON.parse(placements) : [];

      if (req.files.length !== colorArray.length)
        throw new Error("Number of uploaded files does not match number of colors.");

      await promiseConn.query("START TRANSACTION");
      await promiseConn.execute(
        "INSERT INTO logos (id, title, org_id, created_at) VALUES (?, ?, ?, ?)",
        [logoId, title, finalOrgId, createdAt]
      );
      
      for (let i = 0; i < req.files.length; i++) {
        const fileUrl = cloudinaryUrls[i]; 
        
        const [variantResult] = await promiseConn.execute(
          "INSERT INTO logo_variants (logo_id, color, url, created_at) VALUES (?, ?, ?, ?)",
          [logoId, colorArray[i], fileUrl, createdAt]
        );
        const variantId = variantResult.insertId;

        for (const placementName of placementArray) {
          const nameLower = placementName.toLowerCase();
          let view = null;
          
          // 🚀 FIXED PLACEMENT VIEW LOGIC: Supports apparel and non-apparel
          if (nameLower.includes("front") || nameLower.includes("chest") || nameLower.includes("center") || nameLower.includes("full") || nameLower.includes("barrel") || nameLower.includes("clip")) {
            view = "front";
          } else if (nameLower.includes("back")) {
            view = "back";
          } else if (nameLower.includes("left")) {
            view = "left";
          } else if (nameLower.includes("right")) {
            view = "right";
          }
          // END FIXED LOGIC

          let [placementRows] = await promiseConn.execute("SELECT id FROM logo_placements WHERE name = ?", [placementName]);
          let placementId;
          
          if (placementRows.length === 0) {
            placementId = nanoid(4);
            await promiseConn.execute(
              "INSERT INTO logo_placements (id, name, view, created_at) VALUES (?, ?, ?, ?)",
              [placementId, placementName, view, createdAt]
            );
          } else placementId = placementRows[0].id;

          const [linkCheck] = await promiseConn.execute(
            "SELECT 1 FROM logo_variants_placements WHERE logo_variant_id = ? AND logo_placement_id = ?",
            [variantId, placementId]
          );

          if (linkCheck.length === 0) {
            await promiseConn.execute(
              "INSERT INTO logo_variants_placements (logo_variant_id, logo_placement_id, created_at) VALUES (?, ?, ?)",
              [variantId, placementId, createdAt]
            );
          }
        }
      }

      await promiseConn.query("COMMIT");

      res.status(201).json({
        message: "Logo, variants, and placements saved successfully.",
        logoId,
        org_id: finalOrgId
      });
    } catch (error) {
      await promiseConn.query("ROLLBACK").catch(err => console.error("Rollback error:", err));
      console.error("POST /new-logo Error:", error.sqlMessage || error.message);
      res.status(500).json({
        message: "Server error during logo creation. Transaction rolled back.",
        error: error.sqlMessage || error.message
      });
    }
  }
);



// =====================
// ADD Variant
// =====================
route.post(
  "/:id/variant",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  upload.single("logo"),
  async (req, res) => {
    // ❌ REMOVED: let filePath;
    try {
      const { id } = req.params;
      const { color } = req.body;

      if (!req.file) return res.status(400).json({ message: "SVG logo file is required." });

      // ❌ REMOVED: filePath = path.join(uploadDir, req.file.filename);

      const [existing] = await promiseConn.execute("SELECT id FROM logos WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ message: "Logo not found." });

      // 🛑 FIXED: Use uploadToCloudinary
      const fileUrl = await uploadToCloudinary(req.file.buffer, "logos");
      
      // ❌ REMOVED: const fileUrl = `${req.protocol}://${req.get("host")}/uploads/logos/${req.file.filename}`;
      const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");

      await promiseConn.execute(
        "INSERT INTO logo_variants (logo_id, color, url, created_at) VALUES (?, ?, ?, ?)",
        [id, color, fileUrl, createdAt]
      );

      res.status(201).json({ message: "Variant added successfully.", variant: { color, url: fileUrl, created_at: createdAt } });
    } catch (error) {
      // ❌ REMOVED: Local file cleanup (if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);)
      console.error("POST /:id/variant Error:", error.sqlMessage || error.message);
      res.status(500).json({ message: "Server error.", error: error.sqlMessage || error.message });
    }
  }
);

// =====================
// ADD Placements to Variant
// =====================
route.post(
  "/:variantId/placements",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const { variantId } = req.params;
    const { placements } = req.body;

    if (!placements || !Array.isArray(placements) || placements.length === 0)
      return res.status(400).json({ message: "Placements array is required." });

    try {
      const [variantRows] = await promiseConn.execute("SELECT id FROM logo_variants WHERE id = ?", [variantId]);
      if (variantRows.length === 0) return res.status(404).json({ message: "Logo variant not found." });

      const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");
      await promiseConn.query("START TRANSACTION");

      for (const placementName of placements) {
        const nameLower = placementName.toLowerCase();
        let view = null;

        // 🚀 FIXED PLACEMENT VIEW LOGIC: Supports apparel and non-apparel
        if (nameLower.includes("front") || nameLower.includes("chest") || nameLower.includes("center") || nameLower.includes("full") || nameLower.includes("barrel") || nameLower.includes("clip")) {
          view = "front";
        } else if (nameLower.includes("back")) {
          view = "back";
        } else if (nameLower.includes("left")) {
          view = "left";
        } else if (nameLower.includes("right")) {
          view = "right";
        }
        // END FIXED LOGIC

        let [placementRows] = await promiseConn.execute("SELECT id FROM logo_placements WHERE name = ?", [placementName]);
        let placementId;
        
        if (placementRows.length === 0) {
          placementId = nanoid(4);
          await promiseConn.execute(
            "INSERT INTO logo_placements (id, name, view, created_at) VALUES (?, ?, ?, ?)",
            [placementId, placementName, view, createdAt]
          );
        } else placementId = placementRows[0].id;

        const [linkCheck] = await promiseConn.execute(
          "SELECT 1 FROM logo_variants_placements WHERE logo_variant_id = ? AND logo_placement_id = ?",
          [variantId, placementId]
        );

        if (linkCheck.length === 0) {
          await promiseConn.execute(
            "INSERT INTO logo_variants_placements (logo_variant_id, logo_placement_id, created_at) VALUES (?, ?, ?)",
            [variantId, placementId, createdAt]
          );
        }
      }

      await promiseConn.query("COMMIT");
      res.status(201).json({ message: "Placements added successfully.", variantId, placements });
    } catch (error) {
      await promiseConn.query("ROLLBACK").catch(err => console.error("Rollback error:", err));
      console.error("POST /:variantId/placements Error:", error.sqlMessage || error.message);
      res.status(500).json({ message: "Server error. Transaction rolled back.", error: error.sqlMessage || error.message });
    }
  }
);

// =====================
// GET All Logos (Read-only)
// =====================
route.get("/all-logos", Authtoken, async (req, res) => {
  try {
    const requester = req.user;
    const params = [];
    let orgFilter = "";

    if (requester.role !== "Super Admin") {
      orgFilter = "WHERE l.org_id IS NULL OR l.org_id = ?";
      params.push(requester.org_id);
    }

    const [rows] = await promiseConn.query(`
      SELECT 
        l.id AS logo_id,
        l.title,
        l.org_id,
        l.created_at AS logo_created_at,
        lv.id AS variant_id,
        lv.color,
        lv.url,
        lv.created_at AS variant_created_at,
        lp.id AS placement_id,
        lp.name AS placement_name,
        lp.view AS placement_view
      FROM logos l
      LEFT JOIN logo_variants lv ON l.id = lv.logo_id
      LEFT JOIN logo_variants_placements lvp ON lv.id = lvp.logo_variant_id
      LEFT JOIN logo_placements lp ON lvp.logo_placement_id = lp.id
      ${orgFilter}
      ORDER BY l.created_at DESC, lv.id ASC, lp.name ASC
    `, params);

    const logosMap = {};
    rows.forEach(row => {
      if (!logosMap[row.logo_id]) {
        logosMap[row.logo_id] = { 
          id: row.logo_id, 
          title: row.title,
          org_id: row.org_id,
          created_at: row.logo_created_at, 
          variants: {} 
        };
      }

      const logo = logosMap[row.logo_id];

      if (row.variant_id && !logo.variants[row.variant_id]) {
        logo.variants[row.variant_id] = { 
          id: row.variant_id, 
          color: row.color, 
          url: row.url, 
          created_at: row.variant_created_at, 
          placements: [] 
        };
      }

      if (row.variant_id && row.placement_id) {
        logo.variants[row.variant_id].placements.push({ 
          id: row.placement_id, 
          name: row.placement_name, 
          view: row.placement_view 
        });
      }
    });

    const result = Object.values(logosMap).map(logo => ({
      ...logo,
      variants: Object.values(logo.variants)
    }));

    res.json(result);

  } catch (error) {
    console.error("GET /all-logos Error:", error.sqlMessage || error.message);
    res.status(500).json({ 
      message: "Server error.", 
      error: error.sqlMessage || error.message 
    });
  }
});


// =====================
// GET Logo Summary
// =====================
route.get("/logo-summary", Authtoken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    // 🛑 Access Control
    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    // 🧮 Dynamic conditions
    let conditions = [];
    let params = [];

    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

       // 🕒 Timeframe filter
    if (timeframe) {
      switch (timeframe) {
        case "day":
          conditions.push("DATE(created_at) = CURDATE()");
          break;
        case "week":
          conditions.push("YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)");
          break;
        case "month":
          conditions.push("MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())");
          break;
        case "year":
          conditions.push("YEAR(created_at) = YEAR(CURDATE())");
          break;
      }
    }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";


    const [totalLogosResult] = await promiseConn.query(
      `
      SELECT COUNT(*) AS total_logos
      FROM logos ${whereClause}`,
      params
    );

    const totalLogos = totalLogosResult[0]?.total_logos || 0;
    res.json({
      success: true,
      data: {
        total_logos: totalLogos      },
    });
  } catch (err) {
    console.error("❌ Error fetching logo summary:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching logo summary.",
    });
  }
});

// GET logos which have placements for a product
route.get("/product-variant-logos/:variant_id", optionalAuth, async (req, res) => {
  try {
    const { variant_id } = req.params;
    const user = req.user;
    let params = [variant_id];
    
    // Logic: Humein wahi logos chahiye jinka placement variant_logo_positions mein hai
    let orgFilter = "AND (l.org_id IS NULL)";
    if (user && user.org_id) {
      orgFilter = "AND (l.org_id IS NULL OR l.org_id = ?)";
      params.push(user.org_id);
    }

    const [rows] = await promiseConn.query(`
      SELECT DISTINCT 
        l.id AS logo_id, l.title, 
        lv.id AS logo_variant_id, lv.color AS logo_color, lv.url AS logo_url,
        vlp.name AS placement_name, 
        lp.view AS placement_view,
        lp.id AS placement_id,
        vlp.position_x_percent, vlp.position_y_percent, vlp.width_percent
      FROM variant_logo_positions vlp
      JOIN logos l ON vlp.logo_id = l.id
      JOIN logo_variants lv ON vlp.logo_variant_id = lv.id
      JOIN logo_placements lp ON vlp.name = lp.name -- Name ya ID se link karein
      WHERE vlp.variant_id = ? 
      ${orgFilter}
    `, params);

    // Grouping for Frontend (Logos -> Variants -> Placements)
    const logosMap = {};
    rows.forEach(row => {
      if (!logosMap[row.logo_id]) {
        logosMap[row.logo_id] = { id: row.logo_id, title: row.title, variants: {} };
      }
      if (!logosMap[row.logo_id].variants[row.logo_variant_id]) {
        logosMap[row.logo_id].variants[row.logo_variant_id] = {
          id: row.logo_variant_id, color: row.logo_color, url: row.logo_url, placements: []
        };
      }
      logosMap[row.logo_id].variants[row.logo_variant_id].placements.push({
        id: row.placement_id,
        name: row.placement_name,
        view: row.placement_view,
        x: row.position_x_percent,
        y: row.position_y_percent,
        w: row.width_percent
      });
    });

    res.json(Object.values(logosMap).map(l => ({
      ...l, variants: Object.values(l.variants)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================
// GET Single Logo
// =====================
route.get("/:id", Authtoken, async (req, res) => {
  try {
    const { id } = req.params;
    const requester = req.user;
    const [logos] = await promiseConn.query(
      "SELECT id, title, org_id, created_at FROM logos WHERE id = ?",
      [id]
    );

    if (logos.length === 0) {
      return res.status(404).json({ message: "Logo not found." });
    }

    const logo = logos[0];

    if (
      requester.role !== "Super Admin" &&
      logo.org_id !== null &&
      logo.org_id !== requester.org_id
    ) {
      return res.status(403).json({
        message: "You are not authorized to view logos of this organization."
      });
    }

    const [rows] = await promiseConn.query(`
      SELECT 
        lv.id AS variant_id,
        lv.color,
        lv.url,
        lv.created_at AS variant_created_at,
        lp.id AS placement_id,
        lp.name AS placement_name,
        lp.view AS placement_view
      FROM logo_variants lv
      LEFT JOIN logo_variants_placements lvp ON lv.id = lvp.logo_variant_id
      LEFT JOIN logo_placements lp ON lvp.logo_placement_id = lp.id
      WHERE lv.logo_id = ?
      ORDER BY lv.id ASC, lp.name ASC
    `, [id]);

    const variantsMap = {};
    rows.forEach(row => {
      if (!variantsMap[row.variant_id]) {
        variantsMap[row.variant_id] = {
          id: row.variant_id,
          color: row.color,
          url: row.url,
          created_at: row.variant_created_at,
          placements: []
        };
      }
      if (row.placement_id) {
        variantsMap[row.variant_id].placements.push({
          id: row.placement_id,
          name: row.placement_name,
          view: row.placement_view
        });
      }
    });

    const result = {
      id: logo.id,
      title: logo.title,
      org_id: logo.org_id,
      created_at: logo.created_at,
      variants: Object.values(variantsMap)
    };

    res.json(result);

  } catch (error) {
    console.error("GET /:id Error:", error.sqlMessage || error.message);
    res.status(500).json({ 
      message: "Server error.", 
      error: error.sqlMessage || error.message 
    });
  }
});

// =====================
// GET Placements for a Variant
// =====================
route.get("/:variantId/placements", Authtoken, async (req, res) => {
  const { variantId } = req.params;
  const requester = req.user;

  try {
    // Fetch the variant and its parent logo's org_id
    const [variants] = await promiseConn.execute(`
      SELECT lv.id, l.org_id
      FROM logo_variants lv
      JOIN logos l ON lv.logo_id = l.id
      WHERE lv.id = ?
    `, [variantId]);

    if (variants.length === 0) return res.status(404).json({ message: "Variant not found." });

    const variant = variants[0];

    // Organization-based access enforcement
    if (requester.role !== "Super Admin" && variant.org_id !== null && variant.org_id !== requester.org_id) {
      return res.status(403).json({
        message: "You are not authorized to access the placements of this variant."
      });
    }

    // Fetch placements
    const [rows] = await promiseConn.query(
      `SELECT lp.id, lp.name, lp.view, lvp.created_at
       FROM logo_variants_placements lvp
       JOIN logo_placements lp ON lvp.logo_placement_id = lp.id
       WHERE lvp.logo_variant_id = ?`,
      [variantId]
    );

    res.json(rows);

  } catch (error) {
    console.error("GET /:variantId/placements Error:", error.sqlMessage || error.message);
    res.status(500).json({ message: "Server error.", error: error.sqlMessage || error.message });
  }
});


// =====================
// DELETE Logo
// =====================
route.delete("/:id", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
  const { id } = req.params;
  const requester = req.user;

  try {
    const [logos] = await promiseConn.execute("SELECT id, org_id FROM logos WHERE id = ?", [id]);
    if (logos.length === 0) return res.status(404).json({ message: "Logo not found." });

    const logo = logos[0];

    if (requester.role !== "Super Admin" && logo.org_id !== requester.org_id) {
      return res.status(403).json({
        message: "You are not authorized to delete logos of this organization."
      });
    }

    const [variantRows] = await promiseConn.execute("SELECT id, url FROM logo_variants WHERE logo_id = ?", [id]);

    await promiseConn.query("START TRANSACTION");

    for (const variant of variantRows) {
      await promiseConn.execute(
        "DELETE FROM logo_variants_placements WHERE logo_variant_id = ?",
        [variant.id]
      );
    }

    await promiseConn.execute("DELETE FROM logo_variants WHERE logo_id = ?", [id]);

    await promiseConn.execute("DELETE FROM logos WHERE id = ?", [id]);

    await promiseConn.query("COMMIT");

    const deletePromises = variantRows.map(variant => deleteFromCloudinary(variant.url));
await Promise.all(deletePromises);



    res.json({ message: "Logo, variants, and placements deleted successfully." });

  } catch (error) {
    await promiseConn.query("ROLLBACK").catch(err => console.error("Rollback error:", err));
    console.error("DELETE /:id Error:", error.sqlMessage || error.message);
    res.status(500).json({
      message: "Server error. Transaction rolled back.",
      error: error.sqlMessage || error.message
    });
  }
});


// =====================
// DELETE Variant
// =====================
route.delete("/variant/:variantId", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
  const { variantId } = req.params;
  const requester = req.user;

  try {

    const [variants] = await promiseConn.execute(`
      SELECT lv.id, lv.url, l.org_id
      FROM logo_variants lv
      JOIN logos l ON lv.logo_id = l.id
      WHERE lv.id = ?
    `, [variantId]);

    if (variants.length === 0) return res.status(404).json({ message: "Variant not found." });

    const variant = variants[0];
    if (requester.role !== "Super Admin" && variant.org_id !== requester.org_id) {
      return res.status(403).json({
        message: "You are not authorized to delete variants of this organization's logo."
      });
    }

    await promiseConn.query("START TRANSACTION");

    await promiseConn.execute(
      "DELETE FROM logo_variants_placements WHERE logo_variant_id = ?",
      [variantId]
    );

    await promiseConn.execute("DELETE FROM logo_variants WHERE id = ?", [variantId]);

    await promiseConn.query("COMMIT");
    await deleteFromCloudinary(variant.url);

    res.json({ message: "Variant deleted successfully." });

  } catch (error) {
    await promiseConn.query("ROLLBACK").catch(err => console.error("Rollback error:", err));
    console.error("DELETE /variant/:variantId Error:", error.sqlMessage || error.message);
    res.status(500).json({
      message: "Server error. Transaction rolled back.",
      error: error.sqlMessage || error.message
    });
  }
});


// =====================
// DELETE all placements for a variant
// =====================
route.delete("/:variantId/placements", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
  const { variantId } = req.params;
  const requester = req.user;

  try {
    const [variants] = await promiseConn.execute(`
      SELECT lv.id, l.org_id
      FROM logo_variants lv
      JOIN logos l ON lv.logo_id = l.id
      WHERE lv.id = ?
    `, [variantId]);

    if (variants.length === 0) return res.status(404).json({ message: "Variant not found." });

    const variant = variants[0];
    if (requester.role !== "Super Admin" && variant.org_id !== requester.org_id) {
      return res.status(403).json({
        message: "You are not authorized to remove placements for this variant."
      });
    }
    await promiseConn.execute(
      "DELETE FROM logo_variants_placements WHERE logo_variant_id = ?",
      [variantId]
    );

    res.json({ message: "All placements removed for this variant." });

  } catch (error) {
    console.error("DELETE /:variantId/placements Error:", error.sqlMessage || error.message);
    res.status(500).json({ message: "Server error.", error: error.sqlMessage || error.message });
  }
});


module.exports = route;
