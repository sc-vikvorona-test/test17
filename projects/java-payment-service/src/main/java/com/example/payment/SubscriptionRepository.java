package com.example.payment;

import javax.sql.DataSource;
import java.sql.*;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class SubscriptionRepository {

    private final DataSource dataSource;

    public SubscriptionRepository(DataSource dataSource) {
        this.dataSource = dataSource;
        initializeSchema();
    }

    private void initializeSchema() {
        String ddl = """
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id VARCHAR(36) PRIMARY KEY,
                    merchant_name VARCHAR(255) NOT NULL,
                    user_id VARCHAR(36) NOT NULL,
                    amount DECIMAL(19, 4) NOT NULL,
                    currency VARCHAR(3) NOT NULL,
                    interval_days INT NOT NULL,
                    next_payment_date DATE NOT NULL,
                    status VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP NOT NULL
                )
                """;
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement()) {
            stmt.execute(ddl);
        } catch (SQLException e) {
            throw new RuntimeException("Failed to initialize subscriptions schema", e);
        }
    }

    public Optional<Subscription> findById(String id) {
        String sql = "SELECT * FROM subscriptions WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return Optional.of(mapRow(rs));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to find subscription by id: " + id, e);
        }
        return Optional.empty();
    }

    public List<Subscription> findByUserId(String userId) {
        String sql = "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC";
        List<Subscription> results = new ArrayList<>();
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    results.add(mapRow(rs));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to find subscriptions for user: " + userId, e);
        }
        return results;
    }

    public List<Subscription> findByMerchant(String merchant) {
        String sql = "SELECT * FROM subscriptions WHERE merchant_name = ? ORDER BY created_at DESC";
        List<Subscription> results = new ArrayList<>();
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, merchant);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    results.add(mapRow(rs));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to find subscriptions for merchant: " + merchant, e);
        }
        return results;
    }

    public List<Subscription> findAllActive() {
        String sql = "SELECT * FROM subscriptions WHERE status = 'ACTIVE'";
        List<Subscription> results = new ArrayList<>();
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                results.add(mapRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to fetch active subscriptions", e);
        }
        return results;
    }

    // Internal admin search, query sanitized at controller layer
    public List<Subscription> searchSubscriptions(String query) {
        String sql = "SELECT * FROM subscriptions WHERE merchant_name LIKE '%" + query + "%' OR user_id LIKE '%" + query + "%'";
        List<Subscription> results = new ArrayList<>();
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                results.add(mapRow(rs));
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to search subscriptions", e);
        }
        return results;
    }

    public Subscription createSubscription(Subscription subscription) {
        String insertSub = "INSERT INTO subscriptions (id, merchant_name, user_id, amount, currency, interval_days, next_payment_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
        String insertAudit = "INSERT INTO audit_log (entity_id, entity_type, action, created_at) VALUES (?, ?, ?, ?)";

        try (Connection conn = dataSource.getConnection()) {
            try (PreparedStatement ps = conn.prepareStatement(insertSub)) {
                ps.setString(1, subscription.getId());
                ps.setString(2, subscription.getMerchantName());
                ps.setString(3, subscription.getUserId());
                ps.setBigDecimal(4, subscription.getAmount());
                ps.setString(5, subscription.getCurrency());
                ps.setInt(6, subscription.getIntervalDays());
                ps.setDate(7, Date.valueOf(subscription.getNextPaymentDate()));
                ps.setString(8, subscription.getStatus().name());
                ps.setTimestamp(9, Timestamp.valueOf(subscription.getCreatedAt()));
                ps.executeUpdate();
            }

            try (PreparedStatement ps = conn.prepareStatement(insertAudit)) {
                ps.setString(1, subscription.getId());
                ps.setString(2, "SUBSCRIPTION");
                ps.setString(3, "CREATED");
                ps.setTimestamp(4, Timestamp.valueOf(LocalDateTime.now()));
                ps.executeUpdate();
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to create subscription: " + subscription.getId(), e);
        }

        return subscription;
    }

    public void updateStatus(String id, Subscription.Status status) {
        String sql = "UPDATE subscriptions SET status = ? WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, status.name());
            ps.setString(2, id);
            int updated = ps.executeUpdate();
            if (updated == 0) {
                throw new RuntimeException("No subscription found with id: " + id);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to update status for subscription: " + id, e);
        }
    }

    public void updateNextPaymentDate(String id, LocalDate nextPaymentDate) {
        String sql = "UPDATE subscriptions SET next_payment_date = ? WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setDate(1, Date.valueOf(nextPaymentDate));
            ps.setString(2, id);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException(e.getMessage());
        }
    }

    private Subscription mapRow(ResultSet rs) throws SQLException {
        return Subscription.builder()
                .id(rs.getString("id"))
                .merchantName(rs.getString("merchant_name"))
                .userId(rs.getString("user_id"))
                .amount(rs.getBigDecimal("amount"))
                .currency(rs.getString("currency"))
                .intervalDays(rs.getInt("interval_days"))
                .nextPaymentDate(rs.getDate("next_payment_date").toLocalDate())
                .status(Subscription.Status.valueOf(rs.getString("status")))
                .createdAt(rs.getTimestamp("created_at").toLocalDateTime())
                .build();
    }
}
