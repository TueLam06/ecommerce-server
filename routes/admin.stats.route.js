const express = require("express");
const router = express.Router();
const pool = require("../db");
const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");

router.use(verifyToken, requireAdmin);

// GET /api/admin/stats - số liệu tổng quan cho trang admin home
router.get("/", async (req, res) => {
    try {
        const [todayRevenueResult, newOrdersResult, pendingOrdersResult, activeProductsResult] =
            await Promise.all([
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
                // Đơn đang chờ xử lý
                pool.query(
                    `SELECT COUNT(*) AS count
                     FROM orders
                     WHERE status = 'pending'`
                ),
                // Sản phẩm đang bán (is_active = true)
                pool.query(
                    `SELECT COUNT(*) AS count
                     FROM products
                     WHERE is_active = true`
                ),
            ]);

        res.json({
            todayRevenue: Number(todayRevenueResult.rows[0].revenue),
            newOrders: Number(newOrdersResult.rows[0].count),
            pendingOrders: Number(pendingOrdersResult.rows[0].count),
            activeProducts: Number(activeProductsResult.rows[0].count),
        });
    } catch (err) {
        console.error("GET /admin/stats error:", err);
        res.status(500).json({ error: "Lỗi server khi lấy thống kê tổng quan" });
    }
});

module.exports = router;