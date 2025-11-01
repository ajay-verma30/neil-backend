import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import dotenv from "dotenv";

import authRoutes from "./routes/authRoutes.js";
import organizationRoutes from "./routes/organizations.js";
import userRoutes from "./routes/users.js";
import groupRoutes from "./routes/groups.js";
import productRoutes from "./routes/products.js";
import logoRoutes from "./routes/logos.js";
import subCategoryRoutes from "./routes/sub-categories.js";
import customizationRoutes from "./routes/customization.js";
import checkoutRoutes from "./routes/orders.js";
import addressRoutes from "./routes/address.js";

dotenv.config();

const app = express();
const __dirname = path.resolve();

app.use(cookieParser());
app.use(express.json());

const allowedOrigins = [
  "http://localhost:3002",
  "http://localhost:3001",
  "https://my-production-domain.com",
  "https://admin-beta-gilt.vercel.app"
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ Serve uploads folder publicly
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.status(200).json({ message: "Working" });
});

app.set("trust proxy", 1);

// 🧩 Routes
app.use("/organization", organizationRoutes);
app.use("/users", userRoutes);
app.use("/groups", groupRoutes);
app.use("/products", productRoutes);
app.use("/logos", logoRoutes);
app.use("/sub-categories", subCategoryRoutes);
app.use("/customization", customizationRoutes);
app.use("/checkout", checkoutRoutes);
app.use("/address", addressRoutes);
app.use("/auth", authRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
