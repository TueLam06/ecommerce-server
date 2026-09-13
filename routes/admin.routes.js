const express = require("express");
const router = express.Router();
const pool = require("../db");
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");

router.use(verifyToken, requireAdmin);

// GET /api/admin/products - admin xem TẤT CẢ, kể cả sản phẩm đã ẩn
router.get("/", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM products ORDER BY id DESC"
        );
        res.json(result.rows);
    } catch (err) {
        console.error("GET /admin/products error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// GET /api/admin/products/categories
router.get("/categories", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name FROM categories ORDER BY name"
        );
        res.json(result.rows);
    } catch (err) {
        console.error("GET /admin/products/categories error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// GET /api/admin/products/:id - Lấy chi tiết 1 sản phẩm
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM products WHERE id = $1",
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("GET /admin/products/:id error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// POST /api/admin/products - Thêm sản phẩm mới
router.post("/", async (req, res) => {
    const { name, price, stock, description, image_url, category_id } = req.body;

    if (!name || price === undefined || stock === undefined) {
        return res.status(400).json({ error: "Thiếu name/price/stock" });
    }
    if (Number(price) < 0 || Number(stock) < 0) {
        return res.status(400).json({ error: "price/stock không được âm" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO products (name, price, stock, description, image, category_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
            [name, price, stock, description || null, image_url || null, category_id || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("POST /admin/products error:", err);
        res.status(500).json({ error: "Lỗi server khi tạo sản phẩm" });
    }
});

// PUT /api/admin/products/:id - Sửa thông tin sản phẩm
// LƯU Ý: không cho sửa "stock" ở đây nữa, dùng route /:id/stock riêng bên dưới
router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { name, price, description, image_url, category_id } = req.body;

    if (price !== undefined && Number(price) < 0) {
        return res.status(400).json({ error: "price không được âm" });
    }

    try {
        const existing = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
        }
        const current = existing.rows[0];

        const result = await pool.query(
            `UPDATE products
             SET name = $1, price = $2, description = $3, image = $4, category_id = $5
             WHERE id = $6 RETURNING *`,
            [
                name ?? current.name,
                price ?? current.price,
                description ?? current.description,
                image_url ?? current.image,
                category_id ?? current.category_id,
                id,
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error("PUT /admin/products/:id error:", err);
        res.status(500).json({ error: "Lỗi server khi cập nhật sản phẩm" });
    }
});

// PATCH /api/admin/products/:id/stock - Điều chỉnh tồn kho
// body: { type: "add" | "subtract" | "set", quantity: number }
router.patch("/:id/stock", async (req, res) => {
    const { id } = req.params;
    const { type, quantity } = req.body;

    if (!["add", "subtract", "set"].includes(type)) {
        return res.status(400).json({ error: "type phải là 'add', 'subtract' hoặc 'set'" });
    }
    if (quantity === undefined || Number(quantity) < 0 || !Number.isInteger(Number(quantity))) {
        return res.status(400).json({ error: "quantity phải là số nguyên không âm" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const existing = await client.query(
            "SELECT * FROM products WHERE id = $1 FOR UPDATE",
            [id]
        );
        if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
        }
        const product = existing.rows[0];

        let newStock;
        if (type === "add") {
            newStock = product.stock + Number(quantity);
        } else if (type === "subtract") {
            newStock = product.stock - Number(quantity);
            if (newStock < 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({
                    error: `Không thể trừ: tồn kho hiện tại chỉ còn ${product.stock}`,
                });
            }
        } else {
            newStock = Number(quantity);
        }

        const result = await client.query(
            "UPDATE products SET stock = $1 WHERE id = $2 RETURNING *",
            [newStock, id]
        );

        await client.query("COMMIT");
        res.json(result.rows[0]);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("PATCH /admin/products/:id/stock error:", err);
        res.status(500).json({ error: "Lỗi server khi cập nhật tồn kho" });
    } finally {
        client.release();
    }
});

// PATCH /api/admin/products/:id/status - Ẩn/hiện sản phẩm (soft delete / khôi phục)
// body: { is_active: boolean }
router.patch("/:id/status", async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
        return res.status(400).json({ error: "is_active phải là true hoặc false" });
    }

    try {
        const result = await pool.query(
            "UPDATE products SET is_active = $1 WHERE id = $2 RETURNING *",
            [is_active, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
        }
        res.json({
            message: is_active ? "Đã hiện lại sản phẩm" : "Đã ẩn sản phẩm",
            product: result.rows[0],
        });
    } catch (err) {
        console.error("PATCH /admin/products/:id/status error:", err);
        res.status(500).json({ error: "Lỗi server khi cập nhật trạng thái" });
    }
});

module.exports = router;