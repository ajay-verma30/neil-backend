// Auth/tokenAuthentication.js

const jwt = require('jsonwebtoken')
require('dotenv').config();

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        // 401: Unauthenticated (no token)
        return res.status(401).json({ message: 'Access Denied. Authentication token required.' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            // 403: Forbidden (invalid or expired token)
            return res.status(403).json({ message: 'Invalid Token or Token Expired' })
        }
        
        // Ensure role and org_id are attached to req.user
        req.user = user; 
        next();
    })
}

module.exports = authenticateToken;