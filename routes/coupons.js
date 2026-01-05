const express = require('express');
const route = express.Router();
const mysqlconnect = require("../db/conn");
const { customAlphabet } = require('nanoid');
const pool = mysqlconnect();
const promisePool = pool.promise(); 
const Authtoken = require("../Auth/tokenAuthentication");
const { sendEmail } = require("./mailer");
require("dotenv").config();

// Role Authorization Middleware
const authorizeRoles = (...allowedRoles) => (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }
    next();
};

// 1. Create New Batch
route.post("/new/batch", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    try {
        const {
            admin_id,
            title,
            coupon_amount,
            number_of_coupons,
            total_amount,
            organizations,
            group_id, 
            payment_status
        } = req.body;

        if (!admin_id || !title || !coupon_amount || !number_of_coupons || !total_amount || !organizations) {
            return res.status(400).json({ message: "Field Missing Value" });
        }

        const [result] = await promisePool.query(
            `INSERT INTO coupon_batches 
            (admin_id, title, coupon_amount, number_of_coupons, total_amount, payment_status, organizations, group_id) 
            VALUES (?,?,?,?,?,?,?,?)`, 
            [
                admin_id, 
                title, 
                coupon_amount, 
                number_of_coupons, 
                total_amount, 
                payment_status || 'PENDING', 
                organizations, 
                group_id || null 
            ]
        );

        return res.status(201).json({
            success: true,
            message: "Batch created!",
            batch_id: result.insertId,
        });
    } catch (err) {
        console.error("Error creating batch:", err);
        return res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
});




// 2. Update Status and Generate Coupons
route.patch("/update-status", Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    const connection = await promisePool.getConnection();
    try {
        const { batchId, status } = req.body;
        await connection.beginTransaction();
        await connection.query(
            "UPDATE coupon_batches SET payment_status = ? WHERE id = ?",
            [status, batchId]
        );

        if (status === "SUCCESS") {
            const [batchRows] = await connection.query(
                "SELECT * FROM coupon_batches WHERE id = ?",
                [batchId]
            );

            if (batchRows.length > 0) {
                const { coupon_amount, number_of_coupons, admin_id, title, organizations, group_id } = batchRows[0];
                const ALPHANUMERIC_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                const generateCode = customAlphabet(ALPHANUMERIC_UPPER, 12);
                const generatedCoupons = [];

                for (let i = 0; i < number_of_coupons; i++) {
                    const rawId = generateCode();
                    const formattedCode = `${rawId.substring(0, 4)}-${rawId.substring(4, 8)}-${rawId.substring(8, 12)}`;
                    
                    await connection.query(
                        `INSERT INTO coupons (batch_id, code, title, amount, status, created_by) 
                         VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
                        [batchId, formattedCode, title, coupon_amount, admin_id]
                    );
                    generatedCoupons.push(formattedCode);
                }
                let usersToNotify = [];
                if (group_id) {
                    const [rows] = await connection.query(
                        `SELECT u.email, u.f_name FROM users u 
                         JOIN user_group ug ON u.id = ug.user_id 
                         WHERE ug.group_id = ?`,
                        [group_id]
                    );
                    usersToNotify = rows;
                } else {
                    const [rows] = await connection.query(
                        "SELECT email, f_name FROM users WHERE org_id = ?",
                        [organizations]
                    );
                    usersToNotify = rows;
                }
                usersToNotify.forEach((user, index) => {
                    const userCoupon = generatedCoupons[index] || "Check Dashboard"; 
                    
                    const emailHtml = `
                        <div style="font-family: Arial, sans-serif; border: 1px solid #ddd; padding: 20px; border-radius: 10px; max-width: 600px;">
                            <h2 style="color: #007bff;">Congratulations ${user.f_name}! 🎉</h2>
                            <p>Accept this coupon as an appreciation of token form us.</p>
                            <div style="background: #f4f4f4; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0; border: 2px dashed #007bff;">
                                <span style="font-size: 14px; color: #666; display: block; margin-bottom: 5px;">YOUR COUPON CODE</span>
                                <strong style="font-size: 24px; color: #333; letter-spacing: 2px;">${userCoupon}</strong>
                            </div>
                            <p><strong>Value:</strong> $${coupon_amount}</p>
                            <p>You can use this code for your next purchase at Neil Prints.</p>
                            <a href="${process.env.FRONTEND_URL}/login" style="background:#007bff; color:white; padding:12px 25px; text-decoration:none; border-radius:5px; display:inline-block; font-weight:bold;">Shop Now</a>
                            <hr style="border: none; border-top: 1px solid #eee; margin-top: 20px;" />
                            <p style="font-size: 11px; color: #999;">If you didn't expect this, please ignore this email.</p>
                        </div>
                    `;
                    sendEmail(user.email, `You received a $${coupon_amount} Coupon!`, emailHtml)
                        .catch(e => console.error(`Email failed for ${user.email}:`, e.message));
                });
            }
        }

        await connection.commit();
        res.json({ success: true, message: "Payment updated, coupons generated, and emails triggered!" });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error("Error in update-status route:", err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// 3. Get Coupon Batches
route.get('/coupon-batch', Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    const connection = await promisePool.getConnection();
    try {
        const user = req.user; 
        const isSuperAdmin = user.role === "Super Admin";
        let query = `
            SELECT cb.id, cb.title, cb.coupon_amount, cb.number_of_coupons, cb.payment_status, cb.created_at, 
                   o.title AS organization_name, CONCAT(u.f_name, ' ', u.l_name) AS created_by
            FROM coupon_batches cb
            JOIN users u ON cb.admin_id = u.id
            JOIN organizations o ON o.id = cb.organizations
        `;

        const queryParams = [];
        if (!isSuperAdmin) {
            query += ` WHERE cb.organizations = ?`;
            queryParams.push(user.org_id); 
        }

        query += ` ORDER BY cb.created_at DESC`;

        const [rows] = await connection.query(query, queryParams);

        res.status(200).json({ 
            success: true, 
            count: rows.length, 
            coupons: rows 
        });
    } catch (err) {
        console.error("❌ Fetch batch error:", err);
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    } finally {
        connection.release();
    }
});


// 4. Get All Individual Coupons
route.get('/all_coupons/:id', Authtoken, authorizeRoles("Super Admin", "Admin", "Manager"), async (req, res) => {
    const connection = await promisePool.getConnection();
    try {
        const batchId = req.params.id;
        const userRole = req.user.role; 
        const userOrgId = req.user.org_id;

        let query = `
            SELECT 
                c.id, c.code, c.title AS coupon_title, c.amount, c.status, c.batch_id, c.created_at, c.redeemed_at,
                CONCAT(u_admin.f_name, ' ', u_admin.l_name) AS creator_name,
                CONCAT(u_redeem.f_name, ' ', u_redeem.l_name) AS redeemer_name,
                cb.organizations AS org_id, o.title AS organization_name
            FROM coupons c
            JOIN coupon_batches cb ON c.batch_id = cb.id
            JOIN organizations o ON o.id = cb.organizations
            JOIN users u_admin ON u_admin.id = cb.admin_id 
            LEFT JOIN users u_redeem ON u_redeem.id = c.redeemed_by
            WHERE cb.id = ?
        `;
        const queryParams = [batchId];

        // ✅ Security Check: Super Admin sab dekh sakta hai, baki sirf apni Org ka
        if (userRole !== "Super Admin") {
            query += ` AND cb.organizations = ?`;
            queryParams.push(userOrgId);
        }
        query += ` ORDER BY c.created_at DESC;`;
        const [rows] = await connection.query(query, queryParams);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "No coupons found or Access Denied" });
        }

        res.status(200).json({ success: true, count: rows.length, coupons: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        connection.release();
    }
});




module.exports = route;