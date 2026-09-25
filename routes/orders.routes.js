const express = require("express");
const router = express.Router();
const pool = require("../db");
const { verifyToken } = require("../middleware/auth.middleware");
const { restoreStock } = require("../utils/orderStock");

// Chuẩn hoá SĐT để so sánh: bỏ ký tự không phải số, +84/84 -> 0
function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.startsWith("84") ? "0" + digits.slice(2) : digits;
}

// Giới hạn đơn giản chống dò SĐT: tối đa 10 lần tra cứu / phút / IP
const trackAttempts = new Map();
function trackLimiter(req, res, next) {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const now = Date.now();
    const entry = trackAttempts.get(ip);
    if (!entry || now - entry.start > 60_000) {
        if (trackAttempts.size > 5000) trackAttempts.clear(); // tránh phình bộ nhớ
        trackAttempts.set(ip, { start: now, count: 1 });
        return next();
    }
    if (++entry.count > 10) {
        return res.status(429).json({ error: "Bạn tra cứu quá nhiều lần, vui lòng thử lại sau 1 phút" });
    }
    next();
}

// POST /api/orders/track - khách (kể cả không đăng nhập) tra đơn bằng mã đơn + SĐT
// body: { orderId, phone } — dùng POST để SĐT không nằm trên URL/log
router.post("/track", trackLimiter, async (req, res) => {
    const { orderId, phone } = req.body;
    const id = Number(String(orderId || "").replace(/^#/, ""));

    if (!Number.isInteger(id) || id <= 0 || !phone) {
        return res.status(400).json({ error: "Vui lòng nhập mã đơn và số điện thoại" });
    }

    try {
        const orderResult = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
        const order = orderResult.rows[0];
        // Sai mã hay sai SĐT đều trả chung 1 lỗi để không lộ đơn nào tồn tại
        if (!order || normalizePhone(order.phone) !== normalizePhone(phone)) {
            return res.status(404).json({ error: "Không tìm thấy đơn hàng khớp với thông tin đã nhập" });
        }

        const itemsResult = await pool.query(
            `SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.price_at_purchase,
                    p.image, p.is_active AS product_is_active
             FROM order_items oi
             LEFT JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = $1
             ORDER BY oi.id`,
            [id]
        );

        const { user_id, ...publicOrder } = order;
        res.json({ ...publicOrder, items: itemsResult.rows });
    } catch (err) {
        console.error("POST /orders/track error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// GET /api/orders/my - lịch sử mua hàng của user đang đăng nhập
// Mỗi đơn kèm danh sách sản phẩm (items) để hiển thị luôn trên trang lịch sử
router.get("/my", verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT o.id, o.customer_name, o.phone, o.address, o.total, o.status, o.created_at,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', oi.id,
                                'product_id', oi.product_id,
                                'product_name', oi.product_name,
                                'quantity', oi.quantity,
                                'price_at_purchase', oi.price_at_purchase,
                                'image', p.image
                            ) ORDER BY oi.id
                        ) FILTER (WHERE oi.id IS NOT NULL),
                        '[]'
                    ) AS items
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN products p ON p.id = oi.product_id
             WHERE o.user_id = $1
             GROUP BY o.id
             ORDER BY o.created_at DESC`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("GET /orders/my error:", err);
        res.status(500).json({ error: "Lỗi server khi lấy lịch sử đơn hàng" });
    }
});

// GET /api/orders/my/:id - chi tiết 1 đơn, chỉ xem được đơn của chính mình
router.get("/my/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const orderResult = await pool.query(
            "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
            [id, req.user.id]
        );
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
        }

        const itemsResult = await pool.query(
            `SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.price_at_purchase,
                    p.image, p.is_active AS product_is_active
             FROM order_items oi
             LEFT JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = $1
             ORDER BY oi.id`,
            [id]
        );

        res.json({ ...orderResult.rows[0], items: itemsResult.rows });
    } catch (err) {
        console.error("GET /orders/my/:id error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// PATCH /api/orders/my/:id/cancel - user tự huỷ đơn của mình
// Chỉ huỷ được khi đơn còn "pending"; huỷ xong thì trả lại tồn kho
router.patch("/my/:id/cancel", verifyToken, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const orderResult = await client.query(
            "SELECT id, status FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
            [id, req.user.id]
        );
        if (orderResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
        }
        if (orderResult.rows[0].status !== "pending") {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Chỉ huỷ được đơn đang chờ xác nhận" });
        }

        await restoreStock(client, id);

        const updated = await client.query(
            "UPDATE orders SET status = 'cancelled' WHERE id = $1 RETURNING *",
            [id]
        );

        await client.query("COMMIT");
        res.json(updated.rows[0]);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("PATCH /orders/my/:id/cancel error:", err);
        res.status(500).json({ error: "Lỗi server khi huỷ đơn hàng" });
    } finally {
        client.release();
    }
});

module.exports = router;
