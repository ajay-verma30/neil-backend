const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { sendEmail } = require("../routes/mailer");
const mysqlconnect = require("../db/conn");
const promiseConn = mysqlconnect().promise();

// ==========================
// Request Password Reset
// ==========================
exports.requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;

    // ✅ Check if user exists
    const [user] = await promiseConn.query(
      "SELECT id, email FROM users WHERE email = ?",
      [email]
    );

    if (user.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = user[0].id;

    // ✅ Generate token & expiry
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // ✅ Upsert token (delete old one if exists)
    await promiseConn.query(
      "DELETE FROM password_reset_tokens WHERE user_id = ?",
      [userId]
    );

    await promiseConn.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, NOW())",
      [userId, tokenHash, expiresAt]
    );

    // ✅ Send reset email
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(
      email
    )}`;
    const html = `
      <h2>Password Reset Request</h2>
      <p>Click below to reset your password:</p>
      <a href="${resetUrl}" target="_blank">${resetUrl}</a>
      <p>This link expires in 15 minutes.</p>
    `;

    await sendEmail(email, "Reset your password", "", html);

    return res.json({ message: "Password reset link sent to your email." });
  } catch (error) {
    console.error("Error in requestPasswordReset:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

// ==========================
// Reset Password
// ==========================
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password required" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // ✅ Find token record
    const [rows] = await promiseConn.query(
      "SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?",
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const tokenRecord = rows[0];
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(400).json({ message: "Token has expired" });
    }

    // ✅ Hash new password and update user
    const hashed = await bcrypt.hash(password, 10);
    await promiseConn.query(
      "UPDATE users SET hashpassword = ? WHERE id = ?",
      [hashed, tokenRecord.user_id]
    );

    // ✅ Delete used token
    await promiseConn.query(
      "DELETE FROM password_reset_tokens WHERE user_id = ?",
      [tokenRecord.user_id]
    );

    return res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error in resetPassword:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
