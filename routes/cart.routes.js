const express = require("express");
const router = express.Router();
const pool = require("../db");
const { verifyToken } = require("../middleware/auth.middleware");

router.get("/", verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
         ci.product_id,
         ci.quantity,
         p.name,
         p.price,
         p.image,
         p.stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = $1
       ORDER BY ci.updated_at DESC`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

// POST /api/cart — thêm sản phẩm vào giỏ (nếu đã có thì cộng dồn quantity)
// Body: { product_id, quantity }
router.post("/", verifyToken, async (req, res) => {
    const { product_id, quantity } = req.body;

    if (!product_id || !quantity || quantity <= 0) {
        return res.status(400).json({ error: "Thiếu product_id hoặc quantity không hợp lệ." });
    }

    try {
        // Kiểm tra sản phẩm có tồn tại không (tránh thêm sản phẩm rác vào giỏ)
        const productCheck = await pool.query("SELECT id, stock FROM products WHERE id = $1", [product_id]);
        if (productCheck.rows.length === 0) {
            return res.status(404).json({ error: "Sản phẩm không tồn tại." });
        }

        const result = await pool.query(
            `INSERT INTO cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = now()
       RETURNING product_id, quantity`,
            [req.user.id, product_id, quantity]
        );

        res.status(201).json({ message: "Đã thêm vào giỏ hàng.", item: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

// PUT /api/cart/:productId — set số lượng cụ thể cho 1 sản phẩm trong giỏ
// Body: { quantity }
router.put("/:productId", verifyToken, async (req, res) => {
    const { productId } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
        return res.status(400).json({ error: "quantity phải lớn hơn 0. Dùng DELETE để xoá khỏi giỏ." });
    }

    try {
        const result = await pool.query(
            `UPDATE cart_items
       SET quantity = $1, updated_at = now()
       WHERE user_id = $2 AND product_id = $3
       RETURNING product_id, quantity`,
            [quantity, req.user.id, productId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Sản phẩm không có trong giỏ hàng." });
        }

        res.json({ message: "Đã cập nhật số lượng.", item: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

// DELETE /api/cart/:productId — xoá 1 sản phẩm khỏi giỏ
router.delete("/:productId", verifyToken, async (req, res) => {
    const { productId } = req.params;

    try {
        const result = await pool.query(
            "DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2 RETURNING product_id",
            [req.user.id, productId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Sản phẩm không có trong giỏ hàng." });
        }

        res.json({ message: "Đã xoá khỏi giỏ hàng." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

// DELETE /api/cart — xoá sạch giỏ hàng (dùng sau khi checkout xong)
router.delete("/", verifyToken, async (req, res) => {
    try {
        await pool.query("DELETE FROM cart_items WHERE user_id = $1", [req.user.id]);
        res.json({ message: "Đã xoá toàn bộ giỏ hàng." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

module.exports = router;