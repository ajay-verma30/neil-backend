// db/conn.js
const mysql = require("mysql2");

// ✅ Create a MySQL connection pool
const mysqlconnect = () => {
  const pool = mysql.createPool({
    host: "34.47.196.69",
    user: "root",
    password: "123HGAVSD*2136236^%$$KKKSd",
    database: "ecom",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  // ✅ Optional: connection event logs (safe to remove in production)
  pool.on("connection", (connection) => {
    console.log("✅ MySQL new connection established (threadId:", connection.threadId, ")");
  });

  pool.on("release", (connection) => {
    console.log("♻️ MySQL connection released back to pool (threadId:", connection.threadId, ")");
  });

  return pool;
};

module.exports = mysqlconnect;
