package com.example.payment;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

public class Subscription {

    public enum Status {
        ACTIVE, PAUSED, CANCELLED
    }

    private final String id;
    private final String merchantName;
    private final String userId;
    private final BigDecimal amount;
    private final String currency;
    private final int intervalDays;
    private final LocalDate nextPaymentDate;
    private final Status status;
    private final LocalDateTime createdAt;

    private Subscription(Builder builder) {
        this.id = builder.id;
        this.merchantName = builder.merchantName;
        this.userId = builder.userId;
        this.amount = builder.amount;
        this.currency = builder.currency;
        this.intervalDays = builder.intervalDays;
        this.nextPaymentDate = builder.nextPaymentDate;
        this.status = builder.status;
        this.createdAt = builder.createdAt;
    }

    public String getId() { return id; }
    public String getMerchantName() { return merchantName; }
    public String getUserId() { return userId; }
    public BigDecimal getAmount() { return amount; }
    public String getCurrency() { return currency; }
    public int getIntervalDays() { return intervalDays; }
    public LocalDate getNextPaymentDate() { return nextPaymentDate; }
    public Status getStatus() { return status; }
    public LocalDateTime getCreatedAt() { return createdAt; }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private String id;
        private String merchantName;
        private String userId;
        private BigDecimal amount;
        private String currency;
        private int intervalDays;
        private LocalDate nextPaymentDate;
        private Status status;
        private LocalDateTime createdAt;

        public Builder id(String id) { this.id = id; return this; }
        public Builder merchantName(String merchantName) { this.merchantName = merchantName; return this; }
        public Builder userId(String userId) { this.userId = userId; return this; }
        public Builder amount(BigDecimal amount) { this.amount = amount; return this; }
        public Builder currency(String currency) { this.currency = currency; return this; }
        public Builder intervalDays(int intervalDays) { this.intervalDays = intervalDays; return this; }
        public Builder nextPaymentDate(LocalDate nextPaymentDate) { this.nextPaymentDate = nextPaymentDate; return this; }
        public Builder status(Status status) { this.status = status; return this; }
        public Builder createdAt(LocalDateTime createdAt) { this.createdAt = createdAt; return this; }

        public Subscription build() {
            return new Subscription(this);
        }
    }
}
