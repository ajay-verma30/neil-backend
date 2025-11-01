const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const Authtoken = require("../Auth/tokenAuthentication");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cloudinary = require("./cloudinary");

const pool = mysqlconnect();
const promisePool = pool.promise();

const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const ensureDirExists = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

ensureDirExists("./uploads/products");
ensureDirExists("./uploads/variants");
ensureDirExists("./uploads/others");

// ✅ Multer setup
const mixedStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "productImages") cb(null, "./uploads/products");
    else if (file.fieldname.startsWith("variant-")) cb(null, "./uploads/variants");
    else cb(null, "./uploads/others");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const variantUpload = multer({
  storage: mixedStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Invalid file type, only JPEG, PNG, WebP allowed"), false);
  },
}).any();

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Access denied" });
  }
  next();
};

/* -------------------------------------------------------------------------- */
/* ✅ CREATE PRODUCT */
/* -------------------------------------------------------------------------- */
route.post("/new", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });

    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();

      const files = req.files || [];
      const {
        title,
        description,
        sku,
        category,
        price,
        variants,
        group_visibility,
        sub_cat,
        org_id: orgIdFromFrontend,
      } = req.body;

      const requester = req.user;
      const org_id =
        requester.role === "Super Admin"
          ? orgIdFromFrontend || null
          : requester.org_id || orgIdFromFrontend || null;

      if (!title || !description || !sku || !category || !price) {
        await conn.rollback();
        return res.status(400).json({ message: "Missing required fields." });
      }

      // ✅ Insert product
      const productId = nanoid(12);
      const insertQuery = `
        INSERT INTO products 
        (id, title, description, sku, category, price, org_id${sub_cat ? ", sub_cat" : ""}, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?${sub_cat ? ", ?" : ""}, NOW())
      `;
      const params = [productId, title, description, sku, category, price, org_id || null];
      if (sub_cat) params.push(sub_cat);
      await conn.query(insertQuery, params);

      // 🖼 Upload product images to Cloudinary
      const productFiles = files.filter((f) => f.fieldname === "productImages");
      for (const file of productFiles) {
        const uploadRes = await cloudinary.uploader.upload(file.path, {
          folder: "products",
          resource_type: "image",
        });
        fs.unlinkSync(file.path); // delete temp file
        await conn.query("INSERT INTO product_images (product_id, url) VALUES (?, ?)", [
          productId,
          uploadRes.secure_url,
        ]);
      }

      // 🎨 Handle variants
      let parsedVariants = [];
      try {
        parsedVariants = JSON.parse(variants || "[]");
      } catch {
        parsedVariants = [];
      }

      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        if (!v.sku) continue;

        const variantPrice = parseFloat(v.price) || parseFloat(price) || 0.0;
        const [variantRes] = await conn.query(
          "INSERT INTO product_variants (product_id, color, size, sku, price) VALUES (?, ?, ?, ?, ?)",
          [productId, v.color || null, v.size || null, v.sku, variantPrice]
        );

        const variantId = variantRes.insertId;

        // Upload variant images
        const variantFiles = files.filter((f) => f.fieldname.startsWith(`variant-${i}-`));
        for (const file of variantFiles) {
          const type = file.fieldname.split("-")[2] || "front";
          const uploadRes = await cloudinary.uploader.upload(file.path, {
            folder: "variants",
            resource_type: "image",
          });
          fs.unlinkSync(file.path);
          await conn.query(
            "INSERT INTO variant_images (variant_id, url, type) VALUES (?, ?, ?)",
            [variantId, uploadRes.secure_url, type]
          );
        }
      }

      // 👀 Group visibility
      let parsedGV = [];
      try {
        parsedGV =
          typeof group_visibility === "string"
            ? JSON.parse(group_visibility)
            : group_visibility;
      } catch {
        parsedGV = [];
      }

      if (Array.isArray(parsedGV) && parsedGV.length) {
        for (const gv of parsedGV) {
          await conn.query(
            `INSERT INTO group_product_visibility 
             (group_id, product_id, is_visible, created_at, updated_at)
             VALUES (?, ?, ?, NOW(), NOW())`,
            [gv.group_id, productId, gv.is_visible ?? true]
          );
        }
      }

      await conn.commit();
      res.status(201).json({ message: "✅ Product created successfully", productId });
    } catch (e) {
      if (conn) await conn.rollback();
      console.error("❌ Error creating product:", e);
      res.status(500).json({ message: "Internal Server Error", error: e.message });
    } finally {
      if (conn) conn.release();
      // Clean up temp files if any remain
      (req.files || []).forEach((f) => fs.existsSync(f.path) && fs.unlinkSync(f.path));
    }
  });
});


/* -------------------------------------------------------------------------- */
/* ✅ GET ALL PRODUCTS (with org filtering) */
/* -------------------------------------------------------------------------- */
route.get("/all-products", Authtoken, async (req, res) => {
  try {
    const { title, sku, isActive } = req.query;
    const requester = req.user;
    const where = [];
    const params = [];

    // 🔐 Org-level filter
    if (!requester) where.push("org_id IS NULL");
    else if (requester.role !== "Super Admin") {
      if (requester.org_id) {
        where.push("(org_id IS NULL OR org_id = ?)");
        params.push(requester.org_id);
      } else where.push("org_id IS NULL");
    }

    if (title) {
      where.push("title LIKE ?");
      params.push(`%${title}%`);
    }
    if (sku) {
      where.push("sku LIKE ?");
      params.push(`%${sku}%`);
    }
    if (typeof isActive !== "undefined")
      where.push(isActive === "true" || isActive === "1" ? "isActive=TRUE" : "isActive=FALSE");

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const [products] = await promisePool.query(
      `SELECT * FROM products ${whereSql} ORDER BY created_at DESC`,
      params
    );
    if (!products.length) return res.status(404).json({ message: "No products found" });

    const productIds = products.map((p) => p.id);
    const [variants] = await promisePool.query(
      "SELECT id, product_id, color, size, sku, price FROM product_variants WHERE product_id IN (?)",
      [productIds]
    );
    const variantIds = variants.map((v) => v.id);
    const [variantImages] = variantIds.length
      ? await promisePool.query(
          "SELECT variant_id, url, type FROM variant_images WHERE variant_id IN (?)",
          [variantIds]
        )
      : [[]];

    const variantsWithImages = variants.map((v) => ({
      ...v,
      images: variantImages.filter((img) => img.variant_id === v.id),
    }));

    const result = products.map((p) => ({
      ...p,
      variants: variantsWithImages.filter((v) => v.product_id === p.id),
    }));

    res.status(200).json({ products: result });
  } catch (e) {
    console.error("❌ Error fetching products:", e);
    res.status(500).json({ message: "Internal Server Error", error: e.message });
  }
});


/* -------------------------------------------------------------------------- */
/* ✅ PRODUCTS SUMMARY */
/* -------------------------------------------------------------------------- */
route.get("/products-summary", Authtoken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    if (!["Super Admin", "Admin", "Manager"].includes(role))
      return res.status(403).json({ success: false, message: "Access denied." });

    const conditions = [];
    const params = [];

    if (role === "Super Admin" && queryOrg) {
      conditions.push("org_id = ?");
      params.push(queryOrg);
    } else if (role !== "Super Admin") {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    if (timeframe) {
      switch (timeframe) {
        case "day":
          conditions.push("DATE(created_at) = CURDATE()");
          break;
        case "week":
          conditions.push("YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)");
          break;
        case "month":
          conditions.push(
            "MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())"
          );
          break;
        case "year":
          conditions.push("YEAR(created_at) = YEAR(CURDATE())");
          break;
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const [result] = await promisePool.query(
      `SELECT COUNT(*) AS total_products FROM products ${whereClause}`,
      params
    );

    res.json({ success: true, data: { total_products: result[0]?.total_products || 0 } });
  } catch (err) {
    console.error("❌ Error fetching products summary:", err);
    res.status(500).json({ success: false, message: "Server error while fetching summary." });
  }
});

/* -------------------------------------------------------------------------- */
/* ✅ GET SPECIFIC PRODUCT */
/* -------------------------------------------------------------------------- */
route.get("/:id", Authtoken, async (req, res) => {
  try {
    const { id } = req.params;
    const [products] = await promisePool.query("SELECT * FROM products WHERE id=?", [id]);
    if (!products.length) return res.status(404).json({ message: "Product not found" });

    const product = products[0];
    const [images] = await promisePool.query("SELECT * FROM product_images WHERE product_id=?", [
      id,
    ]);
    const [variants] = await promisePool.query(
      "SELECT * FROM product_variants WHERE product_id=?",
      [id]
    );

    const variantIds = variants.map((v) => v.id);
    const [variantImages] = variantIds.length
      ? await promisePool.query(
          "SELECT * FROM variant_images WHERE variant_id IN (?)",
          [variantIds]
        )
      : [[]];

    const variantsWithImages = variants.map((v) => ({
      ...v,
      images: variantImages.filter((img) => img.variant_id === v.id),
    }));

    const [groupVis] = await promisePool.query(
      "SELECT group_id, is_visible FROM group_product_visibility WHERE product_id=?",
      [id]
    );

    res.status(200).json({
      product: {
        ...product,
        images,
        variants: variantsWithImages,
        group_visibility: groupVis,
      },
    });
  } catch (e) {
    console.error("❌ Error fetching product:", e);
    res.status(500).json({ message: "Internal Server Error", error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* ✅ UPDATE PRODUCT */
/* -------------------------------------------------------------------------- */
route.put("/:id", Authtoken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, sku, price, isActive, category, group_visibility } = req.body;
    const requester = req.user;

    if (!["Super Admin", "Admin", "Manager"].includes(requester.role))
      return res.status(403).json({ message: "Not authorized." });

    const [products] = await promisePool.query("SELECT * FROM products WHERE id=?", [id]);
    if (!products.length) return res.status(404).json({ message: "Product not found" });

    const updates = [];
    const params = [];

    if (title) {
      updates.push("title=?");
      params.push(title);
    }
    if (description) {
      updates.push("description=?");
      params.push(description);
    }
    if (sku) {
      const [checkSku] = await promisePool.query(
        "SELECT id FROM products WHERE sku=? AND id!=?",
        [sku, id]
      );
      if (checkSku.length) return res.status(409).json({ message: "SKU already exists" });
      updates.push("sku=?");
      params.push(sku);
    }
    if (price !== undefined) {
      updates.push("price=?");
      params.push(price);
    }
    if (isActive !== undefined) {
      updates.push("isActive=?");
      params.push(isActive);
    }
    if (category) {
      updates.push("category=?");
      params.push(category);
    }

    if (!updates.length && !group_visibility)
      return res.status(400).json({ message: "No fields provided for update" });

    if (updates.length) {
      updates.push("updated_at=?");
      params.push(getCurrentMysqlDatetime(), id);
      await promisePool.query(`UPDATE products SET ${updates.join(", ")} WHERE id=?`, params);
    }

    if (Array.isArray(group_visibility)) {
      await promisePool.query("DELETE FROM group_product_visibility WHERE product_id=?", [id]);
      for (const gv of group_visibility) {
        await promisePool.query(
          "INSERT INTO group_product_visibility (group_id, product_id, is_visible, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())",
          [gv.group_id, id, gv.is_visible ?? true]
        );
      }
    }

    res.status(200).json({ message: "Product updated successfully" });
  } catch (e) {
    console.error("❌ Error updating product:", e);
    res.status(500).json({ message: "Internal Server Error", error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* ✅ DELETE PRODUCT */
/* -------------------------------------------------------------------------- */
route.delete("/:id", Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();

  try {
    const { id } = req.params;

    // 🧾 Find the product
    const [products] = await conn.query("SELECT * FROM products WHERE id=?", [id]);
    if (!products.length)
      return res.status(404).json({ message: "Product not found" });

    await conn.beginTransaction();

    // 🖼 Fetch all related images (product + variants)
    const [productImages] = await conn.query(
      "SELECT url FROM product_images WHERE product_id=?",
      [id]
    );

    const [variants] = await conn.query(
      "SELECT id FROM product_variants WHERE product_id=?",
      [id]
    );

    let variantIds = variants.map((v) => v.id);
    const [variantImages] = variantIds.length
      ? await conn.query(
          "SELECT url FROM variant_images WHERE variant_id IN (?)",
          [variantIds]
        )
      : [[]];

    // 🔥 Delete images from Cloudinary
    const allImages = [...productImages, ...variantImages];
    for (const img of allImages) {
      try {
        // Extract Cloudinary public_id from URL
        const urlParts = img.url.split("/");
        const folderAndFile = urlParts.slice(-2).join("/"); // e.g. "products/abc123.jpg"
        const publicId = folderAndFile.split(".")[0]; // remove file extension
        await cloudinary.uploader.destroy(publicId);
      } catch (cloudErr) {
        console.warn("⚠️ Failed to delete Cloudinary image:", cloudErr.message);
      }
    }

    // 🧹 Delete DB records (cascade)
    await conn.query("DELETE FROM variant_images WHERE variant_id IN (?)", [
      variantIds.length ? variantIds : [0],
    ]);
    await conn.query("DELETE FROM product_images WHERE product_id=?", [id]);
    await conn.query("DELETE FROM product_variants WHERE product_id=?", [id]);
    await conn.query("DELETE FROM group_product_visibility WHERE product_id=?", [id]);
    await conn.query("DELETE FROM products WHERE id=?", [id]);

    await conn.commit();
    res.status(200).json({ message: "✅ Product deleted successfully" });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("❌ Error deleting product:", e);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: e.message });
  } finally {
    if (conn) conn.release();
  }
});


module.exports = route;
