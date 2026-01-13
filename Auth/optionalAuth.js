const jwt = require('jsonwebtoken');

const OptionalAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        req.user = null; 
        return next();
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decodedUser) => {
        if (err) {
            req.user = null;
        } else {
            req.user = decodedUser;
        }
        next();
    });
};

module.exports = OptionalAuth;