const express = require("express");
const router = express.Router();

const { getSanmarProducts } = require("../services/sanmar/sanmarService");

router.get("/products", async (req, res) => {
    try {
        const data = await getSanmarProducts();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch products from SanMar" });
    }
});

module.exports = router;
