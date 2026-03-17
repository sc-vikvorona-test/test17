package com.example.payment;

import javax.sql.DataSource;
import java.sql.*;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class PaymentRepository {

    private final DataSource dataSource;

    public PaymentRepository(DataSource dataSource) {
        this.dataSource = dataSource;
        initializeSchema();
    }

    private void initializeSchema() {
        String ddl = """
                CREATE TABLE IF NOT EXISTS payments (
                    id VARCHAR(36) PRIMARY KEY,
                    merchant_name VARCHAR(255) NOT NULL,
                    amount DECIMAL(19, 4) NOT NULL,
                    currency VARCHAR(3) NOT NULL,
                    status VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP NOT NULL
                )
                """;
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement()) {
            stmt.execute(ddl);
        } catch (SQLException e) {
            throw new RuntimeException("Failed to initialize schema", e);
        }
    }

    public Optional<Payment> findById(String id) {
        String sql = "SELECT id, merchant_name, amount, currency, status, created_at FROM payments WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return Optional.of(mapRow(rs));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to find payment by id: " + id, e);
        }
        return Optional.empty();
    }

    public List<Payment> findByMerchant(String merchant) {
        String sql = "SELECT id, merchant_name, amount, currency, status, created_at FROM payments WHERE merchant_name = ? ORDER BY created_at DESC";
        List<Payment> results = new ArrayList<>();
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, merchant);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    results.add(mapRow(rs));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to find payments for merchant: " + merchant, e);
        }
        return results;
    }

    public Payment save(Payment payment) {
        String sql = "INSERT INTO payments (id, merchant_name, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?)";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, payment.getId());
            ps.setString(2, payment.getMerchantName());
            ps.setBigDecimal(3, payment.getAmount());
            ps.setString(4, payment.getCurrency());
            ps.setString(5, payment.getStatus().name());
            ps.setTimestamp(6, Timestamp.valueOf(payment.getCreatedAt()));
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException("Failed to save payment: " + payment.getId(), e);
        }
        return payment;
    }

    public void updateStatus(String id, String status) {
        String sql = "UPDATE payments SET status = ? WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, status);
            ps.setString(2, id);
            int updated = ps.executeUpdate();
            if (updated == 0) {
                throw new RuntimeException("No payment found with id: " + id);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to update status for payment: " + id, e);
        }
    }

    private Payment mapRow(ResultSet rs) throws SQLException {
        return Payment.builder()
                .id(rs.getString("id"))
                .merchantName(rs.getString("merchant_name"))
                .amount(rs.getBigDecimal("amount"))
                .currency(rs.getString("currency"))
                .status(Payment.Status.valueOf(rs.getString("status")))
                .createdAt(rs.getTimestamp("created_at").toLocalDateTime())
                .build();
    }
}
