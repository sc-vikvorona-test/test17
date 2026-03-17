package com.example.payment;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public class Payment {

    public enum Status {
        PENDING, COMPLETED, FAILED, REFUNDED
    }

    private final String id;
    private final String merchantName;
    private final BigDecimal amount;
    private final String currency;
    private final Status status;
    private final LocalDateTime createdAt;

    private Payment(Builder builder) {
        this.id = builder.id;
        this.merchantName = builder.merchantName;
        this.amount = builder.amount;
        this.currency = builder.currency;
        this.status = builder.status;
        this.createdAt = builder.createdAt;
    }

    public String getId() {
        return id;
    }

    public String getMerchantName() {
        return merchantName;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public String getCurrency() {
        return currency;
    }

    public Status getStatus() {
        return status;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public Builder toBuilder() {
        return new Builder()
                .id(this.id)
                .merchantName(this.merchantName)
                .amount(this.amount)
                .currency(this.currency)
                .status(this.status)
                .createdAt(this.createdAt);
    }

    @Override
    public String toString() {
        return "Payment{id='" + id + "', merchantName='" + merchantName + "', amount=" + amount +
                ", currency='" + currency + "', status=" + status + ", createdAt=" + createdAt + "}";
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private String id;
        private String merchantName;
        private BigDecimal amount;
        private String currency;
        private Status status;
        private LocalDateTime createdAt;

        public Builder id(String id) {
            this.id = id;
            return this;
        }

        public Builder merchantName(String merchantName) {
            this.merchantName = merchantName;
            return this;
        }

        public Builder amount(BigDecimal amount) {
            this.amount = amount;
            return this;
        }

        public Builder currency(String currency) {
            this.currency = currency;
            return this;
        }

        public Builder status(Status status) {
            this.status = status;
            return this;
        }

        public Builder createdAt(LocalDateTime createdAt) {
            this.createdAt = createdAt;
            return this;
        }

        public Payment build() {
            return new Payment(this);
        }
    }
}
