const express = require('express');
const route = express.Router();
const mysqlconnect = require("../db/conn");
const pool = mysqlconnect();
const promisePool = pool.promise(); 
const Authtoken = require("../Auth/tokenAuthentication");
require("dotenv").config();

route.get('/wallet-balance', Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();

  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated"
      });
    }
    const [walletRows] = await conn.query(
      `SELECT balance FROM wallets WHERE user_id = ?`,
      [userId]
    );

    if (walletRows.length === 0) {
      await conn.query(
        `INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)`,
        [userId]
      );
      return res.status(200).json({
        success: true,
        balance: 0.00
      });
    }

    return res.status(200).json({
      success: true,
      balance: walletRows[0].balance
    });

  } catch (err) {
    console.error("❌ Wallet balance error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  } finally {
    conn.release();
  }
});


/* =========================
   GET Wallet Transactions
   ========================= */
route.get('/wallet-transactions', Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();

  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const [txns] = await conn.query(
      `SELECT wt.id, wt.type, wt.amount, wt.description, wt.created_at, c.code AS coupon_code
       FROM wallet_transactions wt
       LEFT JOIN coupons c ON wt.coupon_id = c.id
       WHERE wt.user_id = ?
       ORDER BY wt.created_at DESC`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      transactions: txns
    });

  } catch (err) {
    console.error("❌ Wallet transactions error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  } finally {
    conn.release();
  }
});


route.patch('/deduct-wallet', Authtoken, async (req, res) => {
  const conn = await promisePool.getConnection();

  try {
    const userId = req.user.id;
    const { amount, description } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: "User not authenticated" });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    await conn.beginTransaction();

    // 1️⃣ Fetch current wallet balance
    const [walletRows] = await conn.query(
      "SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE",
      [userId]
    );

    if (walletRows.length === 0) {
      throw new Error("Wallet not found for user");
    }

    const wallet = walletRows[0];

    if (wallet.balance < amount) {
      throw new Error("Insufficient wallet balance");
    }

    // 2️⃣ Deduct balance
    await conn.query(
      "UPDATE wallets SET balance = balance - ? WHERE user_id = ?",
      [amount, userId]
    );

    // 3️⃣ Add wallet transaction
    await conn.query(
      `INSERT INTO wallet_transactions
       (user_id, type, amount, description)
       VALUES (?, 'DEBIT', ?, ?)`,
      [userId, amount, description || "Wallet used for order"]
    );

    await conn.commit();

    return res.status(200).json({
      success: true,
      message: "Wallet deducted successfully",
      deducted_amount: amount,
      new_balance: wallet.balance - amount
    });

  } catch (err) {
    await conn.rollback();
    console.error("❌ Deduct wallet error:", err.message);
    return res.status(400).json({
      success: false,
      message: err.message
    });
  } finally {
    conn.release();
  }
});



module.exports = route;