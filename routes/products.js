const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const mysqlconnect = require("../db/conn");
const Authtoken = require("../Auth/tokenAuthentication");
const multer = require("multer");
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId
} = require("./cloudinary");
const streamifier = require("streamifier");

const pool = mysqlconnect();
const promisePool = pool.promise();

const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Access denied" });
  }
  next();
};

// ✅ Multer memory storage (no local files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, or WebP allowed"));
  },
}).any();

// ✅ Helper: Upload buffer to Cloudinary
// const uploadToCloudinary = (buffer, folder) =>
//   new Promise((resolve, reject) => {
//     const stream = cloudinary.uploader.upload_stream(
//       { folder },
//       (error, result) => {
//         if (error) reject(error);
//         else resolve(result.secure_url);
//       }
//     );
//     streamifier.createReadStream(buffer).pipe(stream);
//   });

/* -------------------------------------------------------------------------- */
/* ✅ CREATE PRODUCT (Cloudinary-based) */
/* -------------------------------------------------------------------------- */
route.post(
  "/new",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  upload,
  async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();

      const files = req.files || [];
      const {
  title,
  description,
  sku,
  price,
  actual_price,
  variants,
  group_visibility,
  category_id,
  sub_category_id,
  org_id: orgIdFromFrontend
} = req.body;

      const requester = req.user;
      const org_id =
        requester.role === "Super Admin"
          ? orgIdFromFrontend || null
          : requester.org_id || orgIdFromFrontend || null;

      if (!title || !description || !sku || !price || !category_id)
  return res.status(400).json({ message: "Missing required fields" });

      // 🧾 Create base product
      const productId = nanoid(12);
      const insertProduct = `
        INSERT INTO products 
        (id, title, description, sku, category_id,sub_category_id, price,actual_price, org_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?,?, ?,?, NOW())
      `;
      const params = [productId, title, description, sku, category_id,sub_category_id,sub_category_id, price,actual_price, org_id || null];
      await conn.query(insertProduct, params);

      // 🖼 Upload product images to Cloudinary (UNCHANGED)
      const productImages = files.filter((f) => f.fieldname === "productImages");
      for (const file of productImages) {
        const url = await uploadToCloudinary(file.buffer, "products");
        await conn.query("INSERT INTO product_images (product_id, url) VALUES (?, ?)", [
          productId,
          url,
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

        // 1. INSERT into product_variants (NO size or size-level price)
        const [variantRes] = await conn.query(
          "INSERT INTO product_variants (product_id, color, sku) VALUES (?, ?, ?)",
          [productId, v.color || null, v.sku]
        );
        const variantId = variantRes.insertId;

        // 2. INSERT into variant_size_attributes (New logic for size and price adjustment)
        let parsedSizes = [];
        try {
            // v.sizes is expected to be an array of objects: 
            // [{"name": "L", "adjustment": 5.00, "stock": 10}, ...]
            parsedSizes = Array.isArray(v.sizes) ? v.sizes : JSON.parse(v.sizes || "[]");
        } catch {}


        if (parsedSizes.length > 0) {
            for (const sizeAttr of parsedSizes) {
                if (!sizeAttr.name) continue;

                const adjustment = parseFloat(sizeAttr.adjustment) || 0.00;
                const stock = parseInt(sizeAttr.stock) || 0;

                await conn.query(
                    `INSERT INTO variant_size_attributes 
                    (variant_id, size, price_adjustment, stock_quantity) 
                    VALUES (?, ?, ?, ?)`,
                    [variantId, sizeAttr.name, adjustment, stock]
                );
            }
        }
        
        // Upload variant images to Cloudinary (UNCHANGED)
        const variantFiles = files.filter((f) => f.fieldname.startsWith(`variant-${i}-`));
        for (const file of variantFiles) {
          const type = file.fieldname.split("-")[2] || "front";
          const url = await uploadToCloudinary(file.buffer, "variants");
          await conn.query(
            "INSERT INTO variant_images (variant_id, url, type) VALUES (?, ?, ?)",
            [variantId, url, type]
          );
        }
      }

      // 👀 Group visibility (UNCHANGED)
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
    }
  }
);


//get all products
route.get("/all-products", Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();
  try {
    const { title, sku, isActive } = req.query;
    const requester = req.user;

    const where = [];
    const params = [];

    // 🧩 Organization logic
    if (!requester) {
      where.push("org_id IS NULL");
    } else if (requester.role !== "Super Admin") {
      if (requester.org_id) {
        where.push("(org_id IS NULL OR org_id = ?)");
        params.push(requester.org_id);
      } else {
        where.push("org_id IS NULL");
      }
    }

    // 🧠 Search filters
    if (title) {
      where.push("title LIKE ?");
      params.push(`%${title}%`);
    }
    if (sku) {
      where.push("sku LIKE ?");
      params.push(`%${sku}%`);
    }
    if (typeof isActive !== "undefined") {
      where.push("isActive = ?");
      params.push(isActive === "true" || isActive === "1" ? 1 : 0);
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    // 🧾 Fetch products
    const [products] = await conn.query(
      `SELECT * FROM products ${whereSql} ORDER BY created_at DESC`,
      params
    );

    // Return empty array if no products found
    if (!products.length) return res.status(200).json({ products: [] });

    const productIds = products.map((p) => p.id);

    // 🧩 Fetch variants for all products
    const productPlaceholders = productIds.map(() => "?").join(",");
    const [variants] = await conn.query(
      `SELECT id, product_id, color, sku
       FROM product_variants
       WHERE product_id IN (${productPlaceholders})`,
      productIds
    );

    const variantIds = variants.map((v) => v.id);

    // 🖼 Fetch variant images
    let variantImages = [];
    if (variantIds.length) {
      const variantPlaceholders = variantIds.map(() => "?").join(",");
      [variantImages] = await conn.query(
        `SELECT variant_id, url, type
         FROM variant_images
         WHERE variant_id IN (${variantPlaceholders})`,
        variantIds
      );
    }

    // 📏 Fetch variant size attributes
    let sizeAttributes = [];
    if (variantIds.length) {
      const variantPlaceholders = variantIds.map(() => "?").join(",");
      [sizeAttributes] = await conn.query(
        `SELECT variant_id, size AS name, price_adjustment AS adjustment, stock_quantity AS stock
         FROM variant_size_attributes
         WHERE variant_id IN (${variantPlaceholders})`,
        variantIds
      );
    }

    // 🧠 Combine variants with images and attributes
    const variantsWithAttributes = variants.map((v) => ({
      ...v,
      images: variantImages.filter((img) => img.variant_id === v.id),
      attributes: sizeAttributes.filter((attr) => attr.variant_id === v.id),
    }));

    // 🧱 Combine products with their variants
    const result = products.map((p) => ({
      ...p,
      variants: variantsWithAttributes.filter((v) => v.product_id === p.id),
    }));

    res.status(200).json({ products: result });
  } catch (e) {
    console.error("❌ Error fetching products:", e);
    res.status(500).json({ message: "Internal Server Error", error: e.message });
  } finally {
    if (conn) conn.release();
  }
});



// 📚 Get all categories and subcategories (for sidebar)
route.get("/categories-subcategories", Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();
  try {
    const categories = ["Tshirts", "Mugs", "Pens", "Bottles", "Books", "Hoodies"];
    const [rows] = await conn.query(`
      SELECT category, GROUP_CONCAT(title ORDER BY title ASC) AS subcategories
      FROM sub_categories
      GROUP BY category
    `);
    const categoryMap = {};
    rows.forEach((r) => {
      categoryMap[r.category] = r.subcategories ? r.subcategories.split(",") : [];
    });
      const result = categories.map((cat) => ({
      category: cat,
      subcategories: categoryMap[cat] || [],
    }));
    res.status(200).json({
      message: "✅ Categories fetched successfully.",
      categories: result,
    });
  } catch (err) {
    console.error("❌ Error fetching categories:", err);
    res.status(500).json({
      message: "Server error fetching categories.",
      error: err.message,
    });
  } finally {
    if (conn) conn.release();
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
  const conn = await promisePool.getConnection();
  try {
    const { id } = req.params;

    // 1️⃣ Fetch main product
    const [productRows] = await conn.query(
      "SELECT * FROM products WHERE id = ?",
      [id]
    );
    if (!productRows.length) {
      return res.status(404).json({ message: "Product not found" });
    }
    const product = productRows[0];

    // 2️⃣ Fetch product images
    const [productImages] = await conn.query(
      "SELECT id, product_id, url FROM product_images WHERE product_id = ?",
      [id]
    );

    // 3️⃣ Fetch product variants
    const [variants] = await conn.query(
      "SELECT id, product_id, color, sku FROM product_variants WHERE product_id = ?",
      [id]
    );

    // 4️⃣ If no variants, return product with empty variants
    if (!variants.length) {
      const [groupVis] = await conn.query(
        "SELECT group_id, is_visible FROM group_product_visibility WHERE product_id = ?",
        [id]
      );

      return res.status(200).json({
        product: {
          ...product,
          images: productImages,
          variants: [],
          group_visibility: groupVis,
        },
      });
    }

    const variantIds = variants.map((v) => v.id);

    // 5️⃣ Fetch variant images
    let variantImages = [];
    if (variantIds.length) {
      const placeholders = variantIds.map(() => "?").join(",");
      [variantImages] = await conn.query(
        `SELECT id, variant_id, url, type
         FROM variant_images
         WHERE variant_id IN (${placeholders})`,
        variantIds
      );
    }

    // 6️⃣ Fetch variant size attributes
    let sizeAttributes = [];
    if (variantIds.length) {
      const placeholders = variantIds.map(() => "?").join(",");
      [sizeAttributes] = await conn.query(
        `SELECT variant_id, size AS name, price_adjustment AS adjustment, stock_quantity AS stock
         FROM variant_size_attributes
         WHERE variant_id IN (${placeholders})`,
        variantIds
      );
    }

    // 7️⃣ Merge variants with images and attributes
    const variantsWithDetails = variants.map((v) => {
      const imgs = variantImages.filter((i) => i.variant_id === v.id);
      const attrs = sizeAttributes
        .filter((a) => a.variant_id === v.id)
        .map((a) => ({
          ...a,
          adjustment: Number(a.adjustment || 0).toFixed(2),
          stock: Number(a.stock || 0),
          final_price: (Number(product.price) + Number(a.adjustment || 0)).toFixed(2),
        }));

      return {
        ...v,
        images: imgs,
        attributes: attrs,
      };
    });

    // 8️⃣ Fetch group visibility
    const [groupVis] = await conn.query(
      "SELECT group_id, is_visible FROM group_product_visibility WHERE product_id = ?",
      [id]
    );

    // 9️⃣ Return full product details
    res.status(200).json({
      product: {
        ...product,
        images: productImages,
        variants: variantsWithDetails,
        group_visibility: groupVis,
      },
    });
  } catch (e) {
    console.error("❌ Error fetching specific product:", e);
    res.status(500).json({ message: "Internal Server Error", error: e.message });
  } finally {
    if (conn) conn.release();
  }
});





// //specific product

// route.get("/:id", Authtoken, async (req, res) => {
//   try {
//     const { id } = req.params;
//     const [products] = await promisePool.query("SELECT * FROM products WHERE id=?", [id]);
//     if (!products.length) return res.status(404).json({ message: "Product not found" });

//     const product = products[0];
//     const [images] = await promisePool.query("SELECT * FROM product_images WHERE product_id=?", [
//       id,
//     ]);
//     const [variants] = await promisePool.query(
//       "SELECT * FROM product_variants WHERE product_id=?",
//       [id]
//     );

//     const variantIds = variants.map((v) => v.id);
//     const [variantImages] = variantIds.length
//       ? await promisePool.query(
//           "SELECT * FROM variant_images WHERE variant_id IN (?)",
//           [variantIds]
//         )
//       : [[]];

//     const variantsWithImages = variants.map((v) => ({
//       ...v,
//       images: variantImages.filter((img) => img.variant_id === v.id),
//     }));

//     const [groupVis] = await promisePool.query(
//       "SELECT group_id, is_visible FROM group_product_visibility WHERE product_id=?",
//       [id]
//     );

//     res.status(200).json({
//       product: {
//         ...product,
//         images,
//         variants: variantsWithImages,
//         group_visibility: groupVis,
//       },
//     });
//   } catch (e) {
//     console.error("❌ Error fetching product:", e);
//     res.status(500).json({ message: "Internal Server Error", error: e.message });
//   }
// });


/* -------------------------------------------------------------------------- */
/* ✏️ PATCH UPDATE PRODUCT (Non-Destructive / Upsert Logic) */
/* -------------------------------------------------------------------------- */
route.patch(
  "/edit/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  upload,
  async (req, res) => {
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();

      const { id: productId } = req.params;
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
        deleted_images,
        deleted_variants,
      } = req.body;

      // 1️⃣ Check product exists
      const [productRows] = await conn.query(
        "SELECT * FROM products WHERE id = ?",
        [productId]
      );
      if (!productRows.length) return res.status(404).json({ message: "Product not found" });

      const requester = req.user;
      const org_id =
        requester.role === "Super Admin"
          ? orgIdFromFrontend || productRows[0].org_id
          : requester.org_id || productRows[0].org_id;

      // 2️⃣ Update product fields dynamically
      const updateFields = [];
      const params = [];

      if (title) updateFields.push("title = ?"), params.push(title);
      if (description) updateFields.push("description = ?"), params.push(description);
      if (sku) updateFields.push("sku = ?"), params.push(sku);
      if (category) updateFields.push("category = ?"), params.push(category);
      if (price) updateFields.push("price = ?"), params.push(price);
      if (sub_cat !== undefined) updateFields.push("sub_category_id = ?"), params.push(sub_cat || null);

      if (updateFields.length > 0) {
        await conn.query(
          `UPDATE products SET ${updateFields.join(", ")}, updated_at = NOW() WHERE id = ?`,
          [...params, productId]
        );
      }

      // 3️⃣ Delete selected images
      if (deleted_images) {
        let parsedDeletes = [];
        try { parsedDeletes = JSON.parse(deleted_images); } catch {}
        if (Array.isArray(parsedDeletes) && parsedDeletes.length) {
          const [imagesToDelete] = await conn.query(
            `SELECT url FROM product_images WHERE product_id = ? AND url IN (?)`,
            [productId, parsedDeletes]
          );
          for (const img of imagesToDelete) {
            const publicId = extractPublicId(img.url);
            if (publicId) await deleteFromCloudinary(publicId, "products");
          }
          await conn.query(
            `DELETE FROM product_images WHERE product_id = ? AND url IN (?)`,
            [productId, parsedDeletes]
          );
        }
      }

      // 4️⃣ Add new product images
      const productImages = files.filter((f) => f.fieldname === "productImages");
      for (const file of productImages) {
        const url = await uploadToCloudinary(file.buffer, "products");
        await conn.query(
          "INSERT INTO product_images (product_id, url) VALUES (?, ?)",
          [productId, url]
        );
      }

      // 5️⃣ Delete selected variants
      if (deleted_variants) {
        let parsedDeletedVariants = [];
        try { parsedDeletedVariants = JSON.parse(deleted_variants); } catch {}
        if (Array.isArray(parsedDeletedVariants) && parsedDeletedVariants.length) {
          await conn.query("DELETE FROM variant_images WHERE variant_id IN (?)", [parsedDeletedVariants]);
          await conn.query("DELETE FROM variant_size_attributes WHERE variant_id IN (?)", [parsedDeletedVariants]);
          await conn.query(
            "DELETE FROM product_variants WHERE id IN (?) AND product_id = ?",
            [parsedDeletedVariants, productId]
          );
        }
      }

      // 6️⃣ Upsert variants and sizes
      let parsedVariants = [];
      try { parsedVariants = JSON.parse(variants || "[]"); } catch {}
      for (let i = 0; i < parsedVariants.length; i++) {
        const v = parsedVariants[i];
        if (!v.sku) continue;

        let variantId;
        if (v.id) {
          variantId = v.id;
          await conn.query(
            "UPDATE product_variants SET color = ?, sku = ? WHERE id = ? AND product_id = ?",
            [v.color || null, v.sku, variantId, productId]
          );
        } else {
          const [inserted] = await conn.query(
            "INSERT INTO product_variants (product_id, color, sku) VALUES (?, ?, ?)",
            [productId, v.color || null, v.sku]
          );
          variantId = inserted.insertId;
        }

        // Upsert sizes
        let parsedSizes = [];
        try { parsedSizes = Array.isArray(v.sizes) ? v.sizes : JSON.parse(v.sizes || "[]"); } catch {}
        for (const sizeAttr of parsedSizes) {
          if (!sizeAttr.name) continue;
          const adjustment = parseFloat(sizeAttr.adjustment) || 0;
          const stock = parseInt(sizeAttr.stock) || 0;

          const [existingSize] = await conn.query(
            "SELECT variant_id FROM variant_size_attributes WHERE variant_id = ? AND size = ?",
            [variantId, sizeAttr.name]
          );

          if (existingSize.length > 0) {
            await conn.query(
              "UPDATE variant_size_attributes SET price_adjustment = ?, stock_quantity = ? WHERE variant_id = ? AND size = ?",
              [adjustment, stock, variantId, sizeAttr.name]
            );
          } else {
            await conn.query(
              "INSERT INTO variant_size_attributes (variant_id, size, price_adjustment, stock_quantity) VALUES (?, ?, ?, ?)",
              [variantId, sizeAttr.name, adjustment, stock]
            );
          }
        }

        // Upload variant images
        const variantFiles = files.filter((f) => f.fieldname.startsWith(`variant-${i}-`));
        for (const file of variantFiles) {
          const type = file.fieldname.split("-")[2] || "front";
          const url = await uploadToCloudinary(file.buffer, "variants");
          await conn.query(
            "INSERT INTO variant_images (variant_id, url, type) VALUES (?, ?, ?)",
            [variantId, url, type]
          );
        }
      }

      // 7️⃣ Update group visibility
      if (group_visibility !== undefined) {
        let parsedGV = [];
        try { parsedGV = typeof group_visibility === "string" ? JSON.parse(group_visibility) : group_visibility; } catch { parsedGV = []; }

        await conn.query("DELETE FROM group_product_visibility WHERE product_id = ?", [productId]);
        if (Array.isArray(parsedGV) && parsedGV.length) {
          for (const gv of parsedGV) {
            await conn.query(
              "INSERT INTO group_product_visibility (group_id, product_id, is_visible, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())",
              [gv.group_id, productId, gv.is_visible ?? true]
            );
          }
        }
      }

      await conn.commit();
      res.status(200).json({ message: "✅ Product updated successfully", productId });
    } catch (e) {
      if (conn) await conn.rollback();
      console.error("❌ Error updating product:", e);
      res.status(500).json({ message: "Internal Server Error", error: e.message });
    } finally {
      if (conn) conn.release();
    }
  }
);





/* -------------------------------------------------------------------------- */
/* ✅ UPDATE PRODUCT */
/* -------------------------------------------------------------------------- */

// route.put("/:id", Authtoken, async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { title, description, sku, price, isActive, category, group_visibility } = req.body;
//     const requester = req.user;

//     if (!["Super Admin", "Admin", "Manager"].includes(requester.role))
//       return res.status(403).json({ message: "Not authorized." });

//     const [products] = await promisePool.query("SELECT * FROM products WHERE id=?", [id]);
//     if (!products.length) return res.status(404).json({ message: "Product not found" });

//     const updates = [];
//     const params = [];

//     if (title) {
//       updates.push("title=?");
//       params.push(title);
//     }
//     if (description) {
//       updates.push("description=?");
//       params.push(description);
//     }
//     if (sku) {
//       const [checkSku] = await promisePool.query(
//         "SELECT id FROM products WHERE sku=? AND id!=?",
//         [sku, id]
//       );
//       if (checkSku.length) return res.status(409).json({ message: "SKU already exists" });
//       updates.push("sku=?");
//       params.push(sku);
//     }
//     if (price !== undefined) {
//       updates.push("price=?");
//       params.push(price);
//     }
//     if (isActive !== undefined) {
//       updates.push("isActive=?");
//       params.push(isActive);
//     }
//     if (category) {
//       updates.push("category=?");
//       params.push(category);
//     }

//     if (!updates.length && !group_visibility)
//       return res.status(400).json({ message: "No fields provided for update" });

//     if (updates.length) {
//       updates.push("updated_at=?");
//       params.push(getCurrentMysqlDatetime(), id);
//       await promisePool.query(`UPDATE products SET ${updates.join(", ")} WHERE id=?`, params);
//     }

//     if (Array.isArray(group_visibility)) {
//       await promisePool.query("DELETE FROM group_product_visibility WHERE product_id=?", [id]);
//       for (const gv of group_visibility) {
//         await promisePool.query(
//           "INSERT INTO group_product_visibility (group_id, product_id, is_visible, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())",
//           [gv.group_id, id, gv.is_visible ?? true]
//         );
//       }
//     }

//     res.status(200).json({ message: "Product updated successfully" });
//   } catch (e) {
//     console.error("❌ Error updating product:", e);
//     res.status(500).json({ message: "Internal Server Error", error: e.message });
//   }
// });

/* -------------------------------------------------------------------------- */
/* ✅ DELETE PRODUCT */
route.delete("/:id", Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();

  try {
    const { id } = req.params;

    // 1️⃣ Check if product exists
    const [products] = await conn.query("SELECT * FROM products WHERE id = ?", [id]);
    if (!products.length)
      return res.status(404).json({ message: "Product not found" });

    await conn.beginTransaction();

    // 2️⃣ Fetch product images
    const [productImages] = await conn.query(
      "SELECT url FROM product_images WHERE product_id = ?",
      [id]
    );

    // 3️⃣ Fetch variants and their images
    const [variants] = await conn.query(
      "SELECT id FROM product_variants WHERE product_id = ?",
      [id]
    );
    const variantIds = variants.map((v) => v.id);

    let variantImages = [];
    if (variantIds.length) {
      [variantImages] = await conn.query(
        "SELECT url FROM variant_images WHERE variant_id IN (?)",
        [variantIds]
      );
    }

    // 4️⃣ Delete all images from Cloudinary
    const allImages = [...productImages, ...variantImages];
    for (const img of allImages) {
      try {
        // Extract Cloudinary public_id from URL (handles folders)
        const matches = img.url.match(/\/(?:v\d+\/)?(.+)\.\w+$/);
        const publicId = matches ? matches[1] : null;
        if (publicId) await cloudinary.uploader.destroy(publicId);
      } catch (cloudErr) {
        console.warn("⚠️ Failed to delete Cloudinary image:", cloudErr.message);
      }
    }

    // 5️⃣ Delete DB records
    if (variantIds.length) {
      await conn.query("DELETE FROM variant_images WHERE variant_id IN (?)", [variantIds]);
      await conn.query("DELETE FROM variant_size_attributes WHERE variant_id IN (?)", [variantIds]);
      await conn.query("DELETE FROM product_variants WHERE id IN (?)", [variantIds]);
    }

    await conn.query("DELETE FROM product_images WHERE product_id = ?", [id]);
    await conn.query("DELETE FROM group_product_visibility WHERE product_id = ?", [id]);
    await conn.query("DELETE FROM products WHERE id = ?", [id]);

    await conn.commit();
    res.status(200).json({ message: "✅ Product deleted successfully" });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("❌ Error deleting product:", e);
    res.status(500).json({ message: "Internal Server Error", error: e.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = route;