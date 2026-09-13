const express = require("express");
const router = express.Router();
const pool = require("../db");

const { verifyToken, requireAdmin } = require("../middleware/auth.middleware");

// GET /api/users — admin xem danh sách user (không trả về password)
router.get("/", verifyToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC"
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

// PATCH /api/users/:id/role — admin đổi role của user khác
// Body: { role: "admin" | "customer" }
router.patch("/:id/role", verifyToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    const allowedRoles = ["customer", "admin"];
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({ error: `role phải là một trong: ${allowedRoles.join(", ")}` });
    }

    // Không cho admin tự hạ quyền chính mình để tránh khoá hết quyền admin của hệ thống
    if (String(req.user.id) === String(id) && role !== "admin") {
        return res.status(400).json({ error: "Không thể tự hạ quyền của chính mình." });
    }

    try {
        const result = await pool.query(
            "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role",
            [role, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Không tìm thấy user." });
        }

        res.json({ message: "Cập nhật role thành công.", user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Lỗi server." });
    }
});

module.exports = router;