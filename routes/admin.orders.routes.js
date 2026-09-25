const express = require("express");
const router = express.Router();
const pool = require("../db");
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");
const { restoreStock } = require("../utils/orderStock");

router.use(verifyToken, requireAdmin);

const VALID_STATUSES = ["pending", "confirmed", "shipping", "completed", "cancelled"];
const DELETABLE_STATUSES = ["completed", "cancelled"];

// GET /api/admin/orders - danh sách đơn hàng, có thể filter ?status=pending
router.get("/", async (req, res) => {
    const { status } = req.query;
    try {
        let result;
        if (status) {
            if (!VALID_STATUSES.includes(status)) {
                return res.status(400).json({ error: "status không hợp lệ" });
            }
            result = await pool.query(
                "SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC",
                [status]
            );
        } else {
            result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
        }
        res.json(result.rows);
    } catch (err) {
        console.error("GET /admin/orders error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// GET /api/admin/orders/stats/revenue - thống kê doanh thu
// LƯU Ý: route này phải đặt TRƯỚC route GET /:id, nếu không "stats" sẽ bị hiểu nhầm là :id
router.get("/stats/revenue", async (req, res) => {
    try {
        const totalResult = await pool.query(
            `SELECT COALESCE(SUM(total), 0) AS total_revenue, COUNT(*) AS total_orders
             FROM orders WHERE status = 'completed'`
        );

        const byStatusResult = await pool.query(
            `SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
             FROM orders GROUP BY status`
        );

        const last30DaysResult = await pool.query(
            `SELECT DATE(created_at) AS date, COALESCE(SUM(total), 0) AS revenue
             FROM orders
             WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '30 days'
             GROUP BY DATE(created_at)
             ORDER BY date ASC`
        );

        res.json({
            total_revenue: totalResult.rows[0].total_revenue,
            total_completed_orders: totalResult.rows[0].total_orders,
            by_status: byStatusResult.rows,
            last_30_days: last30DaysResult.rows,
        });
    } catch (err) {
        console.error("GET /admin/orders/stats/revenue error:", err);
        res.status(500).json({ error: "Lỗi server khi lấy thống kê" });
    }
});

// GET /api/admin/orders/:id - chi tiết 1 đơn hàng + danh sách sản phẩm
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const orderResult = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
        }

        const itemsResult = await pool.query(
            `SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.price_at_purchase,
                    p.image, p.is_active AS product_is_active
             FROM order_items oi
             LEFT JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = $1`,
            [id]
        );

        res.json({ ...orderResult.rows[0], items: itemsResult.rows });
    } catch (err) {
        console.error("GET /admin/orders/:id error:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
});

// PATCH /api/admin/orders/:id/status - cập nhật trạng thái đơn
router.patch("/:id/status", async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
            error: `status phải là một trong: ${VALID_STATUSES.join(", ")}`,
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const existing = await client.query(
            "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
            [id]
        );
        if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
        }

        const oldStatus = existing.rows[0].status;
        // Đơn đã huỷ thì khoá, không cho đổi sang trạng thái khác
        if (oldStatus === "cancelled") {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Đơn đã huỷ, không thể đổi trạng thái" });
        }
        // Huỷ đơn -> trả lại tồn kho
        if (status === "cancelled") {
            await restoreStock(client, id);
        }

        const result = await client.query(
            "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
            [status, id]
        );

        await client.query("COMMIT");
        res.json(result.rows[0]);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("PATCH /admin/orders/:id/status error:", err);
        if (err.status) return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Lỗi server khi cập nhật trạng thái" });
    } finally {
        client.release();
    }
});

// DELETE /api/admin/orders/:id - xóa đơn hàng + order_items liên quan
router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const existing = await client.query(
            "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
            [id]
        );
        if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
        }
        // Chỉ xoá được đơn đã kết thúc (giao thành công / đã huỷ)
        if (!DELETABLE_STATUSES.includes(existing.rows[0].status)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Chỉ xoá được đơn đã giao thành công hoặc đã huỷ" });
        }

        await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);
        await client.query("DELETE FROM orders WHERE id = $1", [id]);

        await client.query("COMMIT");
        res.json({ message: "Đã xóa đơn hàng" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("DELETE /admin/orders/:id error:", err);
        res.status(500).json({ error: "Lỗi server khi xóa đơn hàng" });
    } finally {
        client.release();
    }
});

module.exports = router;