const express = require("express");
const router = express.Router();
const pool = require("../db");
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");

router.use(verifyToken, requireAdmin);

// GET /api/admin/stats - số liệu tổng quan cho trang admin home
router.get("/", async (req, res) => {
    try {
        const [
            totalRevenueResult,
            todayRevenueResult,
            newOrdersResult,
            pendingOrdersResult,
            activeProductsResult,
            dailyResult,
        ] = await Promise.all([
            // Tổng doanh thu (mọi đơn đã giao thành công)
            pool.query(
                `SELECT COALESCE(SUM(total), 0) AS revenue
                 FROM orders
                 WHERE status = 'completed'`
            ),
            // Doanh thu hôm nay (chỉ tính đơn completed)
            pool.query(
                `SELECT COALESCE(SUM(total), 0) AS revenue
                 FROM orders
                 WHERE status = 'completed'
                   AND created_at >= CURRENT_DATE
                   AND created_at < CURRENT_DATE + INTERVAL '1 day'`
            ),
            // Đơn hàng mới hôm nay (tất cả trạng thái)
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM orders
                 WHERE created_at >= CURRENT_DATE
                   AND created_at < CURRENT_DATE + INTERVAL '1 day'`
            ),
            // Đơn đang chờ xử lý: chưa kết thúc (không phải đã giao / đã huỷ)
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM orders
                 WHERE status NOT IN ('completed', 'cancelled')`
            ),
            // Sản phẩm đang bán (is_active = true)
            pool.query(
                `SELECT COUNT(*) AS count
                 FROM products
                 WHERE is_active = true`
            ),
            // Doanh thu + số đơn theo ngày trong 14 ngày gần nhất (ngày trống vẫn trả về 0)
            pool.query(
                `SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
                        COALESCE(SUM(o.total) FILTER (WHERE o.status = 'completed'), 0) AS revenue,
                        COUNT(o.id) AS orders
                 FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
                 LEFT JOIN orders o
                   ON o.created_at >= d.day AND o.created_at < d.day + INTERVAL '1 day'
                 GROUP BY d.day
                 ORDER BY d.day ASC`
            ),
        ]);

        res.json({
            totalRevenue: Number(totalRevenueResult.rows[0].revenue),
            todayRevenue: Number(todayRevenueResult.rows[0].revenue),
            newOrders: Number(newOrdersResult.rows[0].count),
            pendingOrders: Number(pendingOrdersResult.rows[0].count),
            activeProducts: Number(activeProductsResult.rows[0].count),
            daily: dailyResult.rows.map((r) => ({
                date: r.date,
                revenue: Number(r.revenue),
                orders: Number(r.orders),
            })),
        });
    } catch (err) {
        console.error("GET /admin/stats error:", err);
        res.status(500).json({ error: "Lỗi server khi lấy thống kê tổng quan" });
    }
});

module.exports = router;