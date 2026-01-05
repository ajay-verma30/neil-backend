const express = require("express");
const route = express.Router();
const { nanoid } = require("nanoid");
const bcrypt = require("bcryptjs");
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect().promise();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const XLSX = require("xlsx");
require("dotenv").config();
const Authtoken = require("../Auth/tokenAuthentication");
const { sendEmail } = require("./mailer");
const authenticateToken = require("../Auth/tokenAuthentication");

const upload = multer({ storage: multer.memoryStorage() });

const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const getCurrentMysqlDatetime = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🧠 Helper Functions
const isSuperAdmin = (user) => user && user.role === "Super Admin";
const authorizeRoles = (...roles) => (req, res, next) =>
  !req.user || !roles.includes(req.user.role)
    ? res.status(403).json({ message: "Access denied" })
    : next();

const generateTokens = (user) => {
  const payload = {
    id: user.id,
    email: user.email,
    org_id: user.org_id,
    role: user.role,
  };
  return {
    accessToken: jwt.sign(payload, ACCESS_SECRET, { expiresIn: "15m" }),
    refreshToken: jwt.sign(payload, REFRESH_SECRET, { expiresIn: "7d" }),
  };
};

/**
 * 🧩 Check organization access
 * NOTE: This is middleware, so it must acquire and release its own connection.
 */
const checkOrgAccess = async (req, res, next) => {
  let conn;
  try {
    conn = await pool.getConnection(); // Use 'pool'
    const { id } = req.params;
    const requester = req.user;

    if (isSuperAdmin(req)) return next();

    const [rows] = await conn.query("SELECT org_id FROM users WHERE id = ?", [
      id,
    ]);
    if (!rows.length)
      return res.status(404).json({ message: "User not found." });

    const target = rows[0];
    if (target.org_id !== requester.org_id)
      return res.status(403).json({
        message: "You are not authorized for this user's organization.",
      });

    next();
  } catch (err) {
    console.error("❌ Org access error:", err);
    res.status(500).json({ message: "Internal Server Error" });
  } finally {
    if (conn) conn.release();
  }
};

/* -------------------------------------------------------------------------- */
/* 🟢 CREATE SUPER ADMIN */
/* -------------------------------------------------------------------------- */
route.post("/super-admin", async (req, res) => {
  const { f_name, l_name, email, contact, password } = req.body;
  let conn;
  try {
    if (!f_name || !l_name || !email || !contact || !password)
      return res
        .status(400)
        .json({ success: false, message: "All fields are required." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [exists] = await conn.query(
      "SELECT id FROM users WHERE email = ? OR contact = ?",
      [email, contact]
    );
    if (exists.length > 0) {
      await conn.rollback();
      return res
        .status(409)
        .json({ success: false, message: "User already exists." });
    }

    const userId = nanoid(9);
    const hashedPassword = await bcrypt.hash(password, 12);

    await conn.query(
      `INSERT INTO users (id, f_name, l_name, email, contact, hashpassword, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Super Admin', ?)`,
      [userId, f_name, l_name, email, contact, hashedPassword, getCurrentMysqlDatetime()]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      message: "Super Admin created successfully.",
      user: { id: userId, f_name, l_name, email, contact, role: "Super Admin" },
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("❌ Error creating Super Admin:", err);
    res.status(500).json({
      success: false,
      message: "Internal Server Error while creating Super Admin.",
      error: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});



/* -----------------------------------
  🚀 CREATE NEW USER
----------------------------------- */

route.post(
  "/new",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    let conn; 
    try {
      conn = await pool.getConnection(); 
      const createdAt = getCurrentMysqlDatetime();
      const { f_name, l_name, email, contact, password, role, org_id } = req.body;
      const requester = req.user;

      let targetOrg = isSuperAdmin(req.user) ? org_id : requester.org_id;

      if (!f_name || !l_name || !email || !contact || !password)
        return res.status(400).json({ message: "All required fields missing." });

      if (!isSuperAdmin(req) && role === "Super Admin")
        return res.status(403).json({ message: "Cannot create Super Admin." });

      await conn.beginTransaction();

      const [existing] = await conn.query(
        "SELECT id FROM users WHERE email=? OR contact=?",
        [email, contact]
      );
      if (existing.length > 0) {
        await conn.rollback();
        return res.status(409).json({ message: "User already exists." });
      }

      const userId = nanoid(9);
      const hash = await bcrypt.hash(password, 10); 
      await conn.query(
        `INSERT INTO users (id, f_name, l_name, email, contact, hashpassword, role, org_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, f_name, l_name, email, contact, hash, role, targetOrg, createdAt]
      );

      // Create a password reset token for initial login
      const resetToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");

      await conn.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
          VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())`,
        [userId, tokenHash]
      );

      const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
      const emailHtml = `
        <h2>Welcome to Neil Prints!</h2>
        <p>Hi ${f_name},</p>
        <p>An account has been created for you. Click below to set your password:</p>
        <a href="${resetLink}" style="background:#007bff;color:#fff;padding:10px 20px;text-decoration:none;border-radius:5px;">Set Password</a>
        <p>This link expires in 1 hour.</p>
      `;
      await sendEmail(email, "Your Account Has Been Created", emailHtml); 

      await conn.commit();
      res.status(201).json({
        message: "User created successfully and email sent.",
        user: { id: userId, f_name, l_name, email, contact, role, org_id: targetOrg },
      });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error("❌ Error creating user:", err);
      res.status(500).json({ message: "Internal Server Error", error: err.message });
    } finally {
      if (conn) conn.release();
    }
  }
);

/* Login Users */
route.post("/login", loginLimiter, async (req, res) => {
  let conn;
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required." });
    }
    conn = await pool.getConnection();
    const [users] = await conn.query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: "No user found." });
    }
    const user = users[0];
    if (!user.isActive) {
      return res
        .status(403)
        .json({ success: false, message: "Account inactive. Contact admin." });
    }
    const isMatch = await bcrypt.compare(password, user.hashpassword);
    if (!isMatch) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid credentials." });
    }
    const { accessToken, refreshToken } = generateTokens(user);
    const tokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");
    await conn.query(
      `
        INSERT INTO user_refresh_tokens (user_id, token_hash, expires_at)
        VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))
        ON DUPLICATE KEY UPDATE 
          token_hash = VALUES(token_hash),
          expires_at = VALUES(expires_at)
      `,
      [user.id, tokenHash]
    );
const isProduction = process.env.NODE_ENV === "production";

res.cookie("refreshToken", refreshToken, {
  httpOnly: true,
  secure: isProduction, 
  sameSite: isProduction ? "None" : "Lax",
  maxAge: 7 * 24 * 60 * 60 * 1000, 
});


    return res.status(200).json({
      success: true,
      message: "Login successful.",
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        org_id: user.org_id,
        f_name: user.f_name,
        l_name: user.l_name,
      },
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

/*Bulk User upload*/
route.post(
  "/bulk-upload",
  Authtoken,
  authorizeRoles("Super Admin", "Admin"),
  upload.single("file"),
  async (req, res) => {
    let conn;
    try {
      const user = req.user;
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded." });

      // 🧾 Read Excel file buffer safely
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json(
        workbook.Sheets[workbook.SheetNames[0]]
      );

      if (rows.length === 0)
        return res.status(400).json({ message: "Excel file is empty." });

      // ✅ Start a dedicated connection for transaction
      conn = await pool.getConnection();
      await conn.beginTransaction();

      let addedUsers = 0,
        updatedUsers = 0,
        createdGroups = 0,
        skippedRows = 0;

      for (const row of rows) {
        const {
          f_name,
          l_name,
          email,
          contact,
          role = "User",
          org_id,
          groups,
        } = row;

        // --- Basic Validation ---
        if (!f_name || !l_name || !email || !contact) {
          skippedRows++;
          continue;
        }

        // --- Determine Organization ID ---
        let orgId = null;
        if (user.role === "Super Admin") {
          if (!org_id) {
            skippedRows++;
            continue;
          }
          orgId = org_id;
        } else if (user.role === "Admin") {
          if (org_id && org_id !== user.org_id) {
            skippedRows++;
            continue;
          }
          orgId = user.org_id;
        } else {
          skippedRows++;
          continue;
        }

        // --- Role Restriction ---
        if (user.role === "Admin" && role === "Super Admin") {
          skippedRows++;
          continue;
        }

        // --- Check Existing User ---
        const [existingUser] = await conn.query(
          "SELECT id FROM users WHERE (email = ? OR contact = ?) AND org_id = ?",
          [email, contact, orgId]
        );

        let userId;
        if (existingUser.length > 0) {
          userId = existingUser[0].id;
          updatedUsers++;
        } else {
          // --- Create New User ---
          userId = nanoid(9);
          const tempPassword = nanoid(8);
          const hashpassword = await bcrypt.hash(tempPassword, 10);

          await conn.query(
            `INSERT INTO users (id, f_name, l_name, email, contact, hashpassword, role, org_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              userId,
              f_name,
              l_name,
              email,
              contact,
              hashpassword,
              role,
              orgId,
              getCurrentMysqlDatetime(),
            ]
          );

          addedUsers++;

          // --- Send Welcome Email (non-blocking) ---
          // This is a common pattern for bulk processes. It's safe to use `pool.query` here
          // instead of `conn.query` IF `sendEmail` is synchronous or does not rely on the transaction.
          // Since it's a non-blocking IIFE, it's fine, but the email content is slightly confusing
          // as it asks the user to reset a password that wasn't sent. The earlier /new route is better.
          (async () => {
            try {
              const subject = "Welcome to ARV Artwork 🎨";
              const html = `
                <p>Hi <strong>${f_name}</strong>,</p>
                <p>Your account has been created on <strong>ARV Artwork</strong>.</p>
                <p>Please log in using your email (<strong>${email}</strong>) and reset your password.</p>
                <p><a href="${process.env.FRONTEND_URL}/reset-password"
                  style="background:#4CAF50;color:white;padding:10px 15px;text-decoration:none;border-radius:5px;">
                  Reset Password</a></p>
                <p>Best,<br/>The ARV Artwork Team</p>
              `;
              await sendEmail(email, subject, html);
              console.log(`📧 Welcome email sent to ${email}`);
            } catch (e) {
              console.error(`❌ Failed email for ${email}:`, e.message);
            }
          })();
        }

        // --- Handle Groups ---
        if (groups && groups.trim() !== "") {
          const groupTitles = groups
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean);

          for (const title of groupTitles) {
            let groupId;

            const [existingGroup] = await conn.query(
              "SELECT id FROM user_groups WHERE title = ? AND org_id = ?",
              [title, orgId]
            );

            if (existingGroup.length > 0) {
              groupId = existingGroup[0].id;
            } else {
              groupId = nanoid(8);
              await conn.query(
                "INSERT INTO user_groups (id, title, org_id, created_at) VALUES (?, ?, ?, ?)",
                [groupId, title, orgId, getCurrentMysqlDatetime()]
              );
              createdGroups++;
            }

            const [linkExists] = await conn.query(
              "SELECT id FROM user_group WHERE user_id = ? AND group_id = ?",
              [userId, groupId]
            );

            if (linkExists.length === 0) {
              await conn.query(
                "INSERT INTO user_group (id, user_id, group_id, added_on) VALUES (?, ?, ?, ?)",
                [nanoid(10), userId, groupId, getCurrentMysqlDatetime()]
              );
            }
          }
        }
      }

      // ✅ Commit transaction
      await conn.commit();

      return res.status(200).json({
        success: true,
        message: "Bulk upload completed successfully.",
        summary: { addedUsers, updatedUsers, createdGroups, skippedRows },
      });
    } catch (error) {
      if (conn) await conn.rollback();
      console.error("❌ Error in bulk upload:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);



/* -----------------------------------
  ♻️ REFRESH TOKEN API
----------------------------------- */
route.post("/refresh", async (req, res) => {
  let conn;
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ message: "No refresh token provided." });
    }
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch (err) {
      return res.status(403).json({ message: "Invalid or expired refresh token." });
    }
    const tokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    conn = await pool.getConnection();

    const [tokenRows] = await conn.query(
      "SELECT * FROM user_refresh_tokens WHERE user_id = ? AND token_hash = ?",
      [decoded.id, tokenHash]
    );

    if (tokenRows.length === 0) {
      return res.status(403).json({ message: "Refresh token not found or invalidated." });
    }

    const [userRows] = await conn.query(
      "SELECT id, email, role, org_id, isActive FROM users WHERE id = ?",
      [decoded.id]
    );

    if (userRows.length === 0 || userRows[0].isActive === 0) {
      return res.status(403).json({ message: "User account inactive or deleted." });
    }

    const user = userRows[0];

    const accessToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        org_id: user.org_id,
        role: user.role,
      },
      ACCESS_SECRET,
      { expiresIn: "15m" }
    );
    return res.status(200).json({
      message: "Access token refreshed successfully.",
      accessToken,
    });
  } catch (e) {
    console.error("❌ Error in /refresh:", e);
    return res
      .status(500)
      .json({ message: "Internal Server Error", error: e.message });
  } finally {
    if (conn) conn.release();
  }
});


/* -----------------------------------
  🚪 LOGOUT API (Securely clears Refresh Token)
----------------------------------- */
route.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;

  if (!refreshToken) {
    return res.status(200).json({ message: "No refresh token found. Logged out." });
  }

  try {
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch {
      console.warn("⚠️ Logout attempt with invalid or expired refresh token.");
    }
    if (decoded?.id) {
      const tokenHash = crypto
        .createHash("sha256")
        .update(refreshToken)
        .digest("hex");

      // Use pool.query for this single operation
      await pool.query(
        "DELETE FROM user_refresh_tokens WHERE user_id = ? AND token_hash = ?",
        [decoded.id, tokenHash]
      );
    }
  } catch (error) {
    console.error("❌ Logout cleanup error:", error);
  }
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  return res.status(200).json({ message: "Logged out successfully." });
});


// GET /users/me
route.get("/me", Authtoken, async (req, res) => {
  try {
    const { id: userId } = req.user;

    // 🧩 Fetch user + organization
    const [users] = await pool.query(
      `
        SELECT 
          u.id,
          u.f_name,
          u.l_name,
          u.email,
          u.contact,
          u.isActive,
          u.created_at,
          u.role,
          u.org_id,
          o.title AS org_name
        FROM users u
        LEFT JOIN organizations o ON u.org_id = o.id
        WHERE u.id = ?
      `,
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const user = users[0];

    // 📚 Fetch user groups
    const [assignedGroups] = await pool.query(
      `
        SELECT g.id, g.title
        FROM user_groups g
        JOIN user_group ug ON ug.group_id = g.id
        WHERE ug.user_id = ?
      `,
      [userId]
    );

    // ✅ Return structured data
    return res.status(200).json({
      user: {
        ...user,
        assigned_groups: assignedGroups,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching profile:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

/* -----------------------------------
  GET ALL USERS (Global for SA, Org-specific for Admin/Manager)
----------------------------------- */

route.get(
  "/all-users",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    try {
      const requester = req.user;
      const { role, isActive, name } = req.query;

      const whereClauses = [];
      const params = [];

      // 🧩 Restrict org scope only for non–super admins
      if (requester.role !== "Super Admin") {
        whereClauses.push("u.org_id = ?");
        params.push(requester.org_id);
      }

      // 🟢 Filter by active/inactive
      if (isActive && isActive !== "") {
        whereClauses.push("u.isActive = ?");
        params.push(isActive === "true" || isActive === "1");
      }

      // 🟢 Filter by role(s)
      if (role) {
        const roles = role.split(",").map((r) => r.trim()).filter(Boolean);
        if (roles.length > 0) {
          whereClauses.push(`u.role IN (${roles.map(() => "?").join(",")})`);
          params.push(...roles);
        }
      }

      // 🟢 Search by name
      if (name && name.trim() !== "") {
        const like = `%${name.trim()}%`;
        whereClauses.push(
          `(u.f_name LIKE ? OR u.l_name LIKE ? OR CONCAT(u.f_name, ' ', u.l_name) LIKE ?)`
        );
        params.push(like, like, like);
      }

      // 🧩 Build final query
      const whereSql = whereClauses.length
        ? `WHERE ${whereClauses.join(" AND ")}`
        : "";

      const sql = `
        SELECT 
          u.id,
          u.f_name,
          u.l_name,
          u.email,
          u.contact,
          u.isActive,
          u.created_at,
          u.role,
          u.org_id,
          COALESCE(o.title, '—') AS org_name,
          GROUP_CONCAT(DISTINCT g.title ORDER BY g.title SEPARATOR ', ') AS user_groups
        FROM users u
        LEFT JOIN user_group ug ON ug.user_id = u.id
        LEFT JOIN user_groups g ON ug.group_id = g.id
        LEFT JOIN organizations o ON u.org_id = o.id
        ${whereSql}
        GROUP BY u.id
        ORDER BY u.created_at DESC;
      `;

      const [users] = await pool.query(sql, params);

      return res.status(200).json({
        success: true,
        total: users.length,
        users,
      });
    } catch (error) {
      console.error("❌ Error in /all-users:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  }
);



/**
 * GET /api/dashboard/users-summary
 * Returns total users and monthly registrations summary
 */
route.get("/users-summary", Authtoken, async (req, res) => {
  try {
    const { role, org_id } = req.user;
    const { org_id: queryOrg, timeframe } = req.query;

    // 🔒 Access Control
    if (!["Super Admin", "Admin", "Manager"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    // 🧮 Build WHERE conditions
    const conditions = [];
    const params = [];

    // 📍 Organization filtering
    if (role === "Super Admin") {
      if (queryOrg) {
        conditions.push("org_id = ?");
        params.push(queryOrg);
      }
    } else {
      conditions.push("org_id = ?");
      params.push(org_id);
    }

    // 🕒 Timeframe filtering
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
        default:
          // Ignore invalid timeframe silently
          break;
      }
    }

    // 🧱 Combine filters
    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    // 📊 Main query — count users
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total_users FROM users ${whereClause}`,
      params
    );

    const totalUsers = rows[0]?.total_users || 0;

    return res.status(200).json({
      success: true,
      data: {
        total_users: totalUsers,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching user summary:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching user summary.",
      error: err.message,
    });
  }
});


/* -----------------------------------
  GET SINGLE USER (Org-specific for Admin/Manager)
----------------------------------- */
route.get(
  "/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const { id: userId } = req.params;
    const requester = req.user;

    try {
      if (!userId) {
        return res.status(400).json({ message: "User ID is required." });
      }
      let query = `
        SELECT 
          u.id,
          u.f_name,
          u.l_name,
          u.email,
          u.contact,
          u.isActive,
          u.created_at,
          u.role,
          u.org_id,
          o.title AS org_name
        FROM users u
        LEFT JOIN organizations o ON u.org_id = o.id
        WHERE u.id = ?
      `;
      const params = [userId];
      if (!isSuperAdmin(requester) && requester.org_id) {
        query += " AND u.org_id = ?";
        params.push(requester.org_id);
      }
      const [userRows] = await pool.query(query, params);

      if (userRows.length === 0) {
        return res.status(404).json({
          message: isSuperAdmin(requester)
            ? "User not found."
            : "User not found or you are not authorized for this organization.",
        });
      }

      const user = userRows[0];
      const [groups] = await pool.query(
        `
          SELECT g.id, g.title
          FROM user_groups g
          INNER JOIN user_group ug ON ug.group_id = g.id
          WHERE ug.user_id = ?
        `,
        [userId]
      );
      return res.status(200).json({
        success: true,
        user: {
          ...user,
          assigned_groups: groups || [],
        },
      });
    } catch (error) {
      console.error("❌ Error fetching user:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error while fetching user.",
        error: error.message,
      });
    }
  }
);

//update my details
route.patch("/my-user", Authtoken, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const userId = req.user.id; 
    const { f_name, l_name, email, contact } = req.body;
    const updateFields = {};
    if (f_name) updateFields.f_name = f_name;
    if (l_name) updateFields.l_name = l_name;
    if (email) updateFields.email = email;
    if (contact) updateFields.contact = contact;

    const keys = Object.keys(updateFields);

    if (keys.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update (f_name, l_name, email, or contact).",
      });
    }
    const setClauses = keys.map(key => `${key} = ?`).join(", ");
    const params = keys.map(key => updateFields[key]);
    params.push(userId);
    const updateQuery = `UPDATE users SET ${setClauses} WHERE id = ?`;
    const [result] = await conn.query(updateQuery, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "No user found with this ID or no changes were made.",
      });
    }
    res.status(200).json({
      success: true,
      message: "User details updated successfully.",
      updatedFields: updateFields,
    });
  } catch (error) {
    console.error("❌ Error updating user:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  } finally {
    if (conn) conn.release();
  }
});


//Update user status
route.patch(
  "/user/:id/status",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const { id } = req.params;
    const { isActive } = req.body;
    const requester = req.user;
    const isSA = requester.role === "Super Admin";

    if (isActive === undefined) {
      return res.status(400).json({ success: false, message: "isActive field required." });
    }

    try {
      const [userRows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
      if (userRows.length === 0)
        return res.status(404).json({ success: false, message: "User not found." });

      const user = userRows[0];

      // Restrict for non-Super Admins
      if (!isSA && requester.org_id !== user.org_id) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to modify this user's status.",
        });
      }

      await pool.query("UPDATE users SET isActive = ? WHERE id = ?", [!!isActive, id]);

      // Fetch updated user
      const [updatedUser] = await pool.query(
        `SELECT id, f_name, l_name, email, contact, isActive, role, org_id, created_at
         FROM users WHERE id = ?`,
        [id]
      );

      return res.status(200).json({
        success: true,
        message: `User ${isActive ? "activated" : "deactivated"} successfully.`,
        user: updatedUser[0],
      });
    } catch (error) {
      console.error("❌ Error updating status:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  }
);


/* -----------------------------------
  PATCH (UPDATE) USER (Org-specific for Admin/Manager)
----------------------------------- */
route.patch(
  "/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    const { id: userId } = req.params;
    const requester = req.user;
    const { isActive, ...updateFields } = req.body;
    const isSA = requester.role === "Super Admin";

    try {
      if (!userId) {
        return res.status(400).json({ message: "User ID is required." });
      }

      // 🔍 If not Super Admin, ensure user belongs to the same org
      if (!isSA) {
        const [targetRows] = await pool.query(
          "SELECT org_id FROM users WHERE id = ?",
          [userId]
        );
        if (targetRows.length === 0) {
          return res.status(404).json({ message: "User not found." });
        }
        const targetOrg = targetRows[0].org_id;
        if (targetOrg !== requester.org_id) {
          return res
            .status(403)
            .json({ message: "Not authorized to modify this user." });
        }
      }

      // 🧩 Build update fields
      const setClauses = [];
      const params = [];

      // Non-Super Admins cannot update sensitive fields
      if (!isSA) {
        const restrictedFields = ["role", "org_id", "hashpassword"];
        for (const field of restrictedFields) {
          if (req.body[field] !== undefined) {
            return res.status(403).json({
              message: `You are not authorized to update the user's ${field}.`,
            });
          }
        }
      }

      // ✅ Handle isActive toggle
      if (isActive !== undefined) {
        setClauses.push("isActive = ?");
        params.push(!!isActive);
      }

      // ✅ Handle other editable fields
      for (const key in updateFields) {
        if (
          isSA || // Super Admin can edit anything
          ["f_name", "l_name", "email", "contact"].includes(key)
        ) {
          setClauses.push(`${key} = ?`);
          params.push(updateFields[key]);
        }
      }

      if (setClauses.length === 0) {
        return res
          .status(400)
          .json({ message: "No valid fields provided for update." });
      }

      // ✅ Execute update
      params.push(userId);
      const [result] = await pool.query(
        `UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return res
          .status(404)
          .json({ message: "User not found or update not applied." });
      }

      res.status(200).json({
        success: true,
        message: "User updated successfully.",
        userId,
        updatedFields: req.body,
      });
    } catch (error) {
      console.error("❌ Error updating user:", error);
      res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  }
);


//update password 
route.patch("/:id/reset-password", Authtoken, async (req, res) => {
  try {
    const { id: userId } = req.params;
    const { oldPassword, newPassword } = req.body;

    // 1️⃣ Fetch the user's current hashed password
    const [rows] = await pool.query(
      "SELECT hashPassword FROM users WHERE id = ?",
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const existingPassword = rows[0].hashPassword;

    // 2️⃣ Compare old password with stored hashed password
    const isMatch = await bcrypt.compare(oldPassword, existingPassword);
    if (!isMatch) {
      return res.status(400).json({ message: "Old password is incorrect" });
    }

    // 3️⃣ Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // 4️⃣ Update the password in the database
    const [result] = await pool.query(
      "UPDATE users SET hashPassword = ? WHERE id = ?",
      [hashedPassword, userId]
    );

    if (result.affectedRows !== 1) {
      return res
        .status(400)
        .json({ message: "Failed to update password. Try again!" });
    }

    // 5️⃣ Success
    return res.status(200).json({ message: "Password updated successfully!" });
  } catch (error) {
    console.error("❌ Error updating password:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
});




// update user groups.
route.patch(
  "/user/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    let connection;
    try {
      connection = await pool.getConnection();
      const { id } = req.params;
      const { group_ids, remove_group_ids } = req.body;
      const requester = req.user;
      const isSA = requester.role === "Super Admin";

      // 🧩 Fetch target user org
      const [targetUser] = await connection.query(
        "SELECT org_id FROM users WHERE id = ?",
        [id]
      );

      if (targetUser.length === 0) {
        return res.status(404).json({ message: "User not found." });
      }

      const targetOrgId = targetUser[0].org_id;

      // 🔒 Restrict non-super-admins
      if (!isSA && requester.org_id !== targetOrgId) {
        return res.status(403).json({
          message:
            "You are not authorized to modify users from another organization.",
        });
      }

      await connection.beginTransaction();

      // ✅ Add Groups
      if (group_ids && Array.isArray(group_ids) && group_ids.length > 0) {
        const [existingLinks] = await connection.query(
          "SELECT group_id FROM user_group WHERE user_id = ?",
          [id]
        );
        const existingGroupIds = existingLinks.map((g) => g.group_id);

        for (const groupId of group_ids) {
          if (!existingGroupIds.includes(groupId)) {
            await connection.query(
              "INSERT INTO user_group (id, user_id, group_id, added_on) VALUES (?, ?, ?, NOW())",
              [nanoid(10), id, groupId]
            );
          }
        }
      }

      // ✅ Remove Groups
      if (
        remove_group_ids &&
        Array.isArray(remove_group_ids) &&
        remove_group_ids.length > 0
      ) {
        await connection.query(
          "DELETE FROM user_group WHERE user_id = ? AND group_id IN (?)",
          [id, remove_group_ids]
        );
      }

      await connection.commit();

      // 🔄 Fetch updated user info + groups
      const [updatedUser] = await connection.query(
        "SELECT id, f_name, l_name, email, contact, role, org_id, isActive FROM users WHERE id = ?",
        [id]
      );
      const [assignedGroups] = await connection.query(
        `
        SELECT g.id, g.title
        FROM user_groups g
        JOIN user_group ug ON ug.group_id = g.id
        WHERE ug.user_id = ?
        `,
        [id]
      );

      return res.status(200).json({
        success: true,
        message: "User groups updated successfully.",
        user: {
          ...updatedUser[0],
          assigned_groups: assignedGroups,
        },
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error("❌ Error updating user groups:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    } finally {
      if (connection) connection.release();
    }
  }
);


// remove group
route.patch(
  "/user/rm_grp/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    try {
      const { id: userId } = req.params;
      const { group_id } = req.body;
      const requester = req.user;
      const isSA = requester.role === "Super Admin";

      if (!group_id) {
        return res.status(400).json({ success: false, message: "group_id is required." });
      }

      // 🔍 Fetch user and their org
      const [userRows] = await pool.query("SELECT org_id FROM users WHERE id = ?", [userId]);
      if (userRows.length === 0) {
        return res.status(404).json({ success: false, message: "User not found." });
      }
      const targetOrgId = userRows[0].org_id;

      // 🔍 Fetch group and its org
      const [groupRows] = await pool.query("SELECT org_id FROM user_groups WHERE id = ?", [group_id]);
      if (groupRows.length === 0) {
        return res.status(404).json({ success: false, message: "Group not found." });
      }
      const groupOrgId = groupRows[0].org_id;

      // 🚫 Restrict cross-org access for non-Super Admins
      if (!isSA && (requester.org_id !== targetOrgId || requester.org_id !== groupOrgId)) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to modify users or groups from another organization.",
        });
      }

      // ✅ Perform deletion
      const [result] = await pool.query(
        "DELETE FROM user_group WHERE user_id = ? AND group_id = ?",
        [userId, group_id]
      );

      if (result.affectedRows === 0) {
        return res.status(400).json({
          success: false,
          message: "No such user-group link found or already removed.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Group removed successfully from user.",
      });
    } catch (error) {
      console.error("❌ Error removing user group:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  }
);


route.delete(
  "/:id",
  Authtoken,
  authorizeRoles("Super Admin", "Admin", "Manager"),
  async (req, res) => {
    let conn;
    try {
      const { id: userId } = req.params;
      const requester = req.user;
      const isSA = requester.role === "Super Admin";

      if (!userId) {
        return res.status(400).json({ success: false, message: "User ID is required." });
      }

      // 🚫 Prevent self-deletion
      if (requester.id === userId) {
        return res.status(403).json({ success: false, message: "You cannot delete your own account." });
      }

      conn = await pool.getConnection();
      await conn.beginTransaction();

      // 🔍 Fetch target user
      const [userRows] = await conn.query("SELECT org_id, role FROM users WHERE id = ?", [userId]);
      if (userRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: "User not found." });
      }

      const targetUser = userRows[0];

      // 🚫 Restrict non-Super Admins from deleting outside their org or higher roles
      if (!isSA) {
        if (targetUser.org_id !== requester.org_id) {
          await conn.rollback();
          return res.status(403).json({
            success: false,
            message: "You are not authorized to delete users from another organization.",
          });
        }
        if (targetUser.role === "Super Admin") {
          await conn.rollback();
          return res.status(403).json({
            success: false,
            message: "You are not authorized to delete a Super Admin.",
          });
        }
      }

      // 🧹 Clean up user-group mappings first
      await conn.query("DELETE FROM user_group WHERE user_id = ?", [userId]);

      // 🗑️ Delete the user
      const [deleteResult] = await conn.query("DELETE FROM users WHERE id = ?", [userId]);
      if (deleteResult.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: "User could not be deleted." });
      }

      await conn.commit();

      return res.status(200).json({
        success: true,
        message: "User deleted successfully.",
        deletedUserId: userId,
      });
    } catch (error) {
      if (conn) await conn.rollback();
      console.error("❌ Error deleting user:", error);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    } finally {
      if (conn) conn.release();
    }
  }
);


module.exports = route;
