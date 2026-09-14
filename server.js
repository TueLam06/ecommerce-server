require('dotenv').config();
const cors = require('cors');
const express = require('express');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const pool = require('./db');

const chatRoutes = require('./chat');
const productRoutes = require("./routes/products");
const authRoutes = require('./routes/auth.routes');
const { optionalAuth } = require('./middleware/auth.middleware');
const userRoutes = require('./routes/users.routes');
const cartRoutes = require('./routes/cart.routes')
const adminRoutes = require('./routes/admin.routes');
const adminOrdersRoutes = require('./routes/admin.orders.routes');
const adminStatsRoutes = require("./routes/admin.stats.route")

app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use("/api/products", productRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/admin/products', adminRoutes);
app.use('/api/admin/orders', adminOrdersRoutes);
app.use("/api/admin/stats", adminStatsRoutes);

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE is_active = true'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM products WHERE id = $1 AND is_active = true',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});


app.post("/api/orders", optionalAuth, async (req, res) => {
    const { customer_name, phone, address } = req.body;

    if (!customer_name || !phone || !address) {
        return res.status(400).json({ message: "Thiếu customer_name/phone/address" });
    }

    const client = await pool.connect();
    try {
        let items = [];

        if (req.user) {
            const cartRes = await client.query(
                "SELECT product_id, quantity FROM cart_items WHERE user_id = $1",
                [req.user.id]
            );
            items = cartRes.rows;
            if (items.length === 0) {
                return res.status(400).json({ message: "Giỏ hàng trống" });
            }
        } else {
            const cart = req.body.cart;
            if (!Array.isArray(cart) || cart.length === 0) {
                return res.status(400).json({ message: "Thiếu cart cho khách vãng lai" });
            }
            items = cart.map((i) => ({ product_id: i.id, quantity: i.quantity }));
        }

        await client.query("BEGIN");

        let total = 0;
        const orderItemsData = [];

        for (const item of items) {
            const pRes = await client.query(
                "SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE",
                [item.product_id]
            );
            if (pRes.rows.length === 0) {
                throw { status: 404, message: `Sản phẩm id ${item.product_id} không tồn tại` };
            }
            const product = pRes.rows[0];
            if (product.stock < item.quantity) {
                throw {
                    status: 400,
                    message: `Sản phẩm "${product.name}" không đủ tồn kho (còn ${product.stock}, cần ${item.quantity})`,
                };
            }
            total += Number(product.price) * item.quantity;
            orderItemsData.push({
                product_id: product.id,
                name: product.name,
                price: product.price,
                quantity: item.quantity,
            });
        }

        const orderRes = await client.query(
            `INSERT INTO orders (customer_name, phone, address, total, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [customer_name, phone, address, total, req.user ? req.user.id : null]
        );
        const orderId = orderRes.rows[0].id;

        for (const oi of orderItemsData) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, product_name)
         VALUES ($1, $2, $3, $4, $5)`,
                [orderId, oi.product_id, oi.quantity, oi.price, oi.name]
            );
            await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [
                oi.quantity,
                oi.product_id,
            ]);
        }

        if (req.user) {
            await client.query("DELETE FROM cart_items WHERE user_id = $1", [req.user.id]);
        }

        await client.query("COMMIT");
        return res.status(201).json({ message: "Đặt hàng thành công", orderId, total });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("POST /api/orders error:", err);
        if (err.status) return res.status(err.status).json({ message: err.message });
        return res.status(500).json({ message: "Lỗi server khi tạo đơn hàng" });
    } finally {
        client.release();
    }
});
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});