// Các hàm cập nhật tồn kho theo đơn hàng — phải gọi bên trong transaction (dùng client, không dùng pool)

// Trả lại tồn kho khi huỷ đơn (bỏ qua sản phẩm đã bị xoá: product_id = null)
async function restoreStock(client, orderId) {
    await client.query(
        `UPDATE products p
         SET stock = p.stock + oi.quantity
         FROM order_items oi
         WHERE oi.order_id = $1 AND oi.product_id = p.id`,
        [orderId]
    );
}

module.exports = { restoreStock };
