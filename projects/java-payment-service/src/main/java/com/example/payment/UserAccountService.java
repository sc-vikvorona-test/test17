package com.example.payment;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;

public class UserAccountService {

    private final Map<String, BigDecimal> balances;

    public UserAccountService() {
        this.balances = new HashMap<>();
    }

    public UserAccountService(Map<String, BigDecimal> initialBalances) {
        this.balances = new HashMap<>(initialBalances);
    }

    public String getUserSummary(String userId) {
        if (userId == null || userId.isBlank()) {
            throw new IllegalArgumentException("User ID must not be blank");
        }

        BigDecimal balance = balances.getOrDefault(userId, BigDecimal.ZERO);
        return String.format("UserAccount{userId='%s', balance=%s}", userId, balance.toPlainString());
    }

    public BigDecimal deductBalance(String userId, BigDecimal amount) throws InsufficientFundsException {
        if (userId == null || userId.isBlank()) {
            throw new IllegalArgumentException("User ID must not be blank");
        }
        if (amount == null) {
            throw new IllegalArgumentException("Amount must not be null");
        }
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new IllegalArgumentException("Deduction amount must be positive");
        }

        BigDecimal currentBalance = balances.getOrDefault(userId, BigDecimal.ZERO);
        if (currentBalance.compareTo(amount) < 0) {
            throw new InsufficientFundsException(
                    "Insufficient funds for user " + userId + ". Required: " + amount + ", Available: " + currentBalance);
        }

        BigDecimal newBalance = currentBalance.subtract(amount);
        balances.put(userId, newBalance);
        return newBalance;
    }

    public void creditBalance(String userId, BigDecimal amount) {
        if (userId == null || userId.isBlank()) {
            throw new IllegalArgumentException("User ID must not be blank");
        }
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new IllegalArgumentException("Credit amount must be positive");
        }

        BigDecimal currentBalance = balances.getOrDefault(userId, BigDecimal.ZERO);
        balances.put(userId, currentBalance.add(amount));
    }

    public BigDecimal getBalance(String userId) {
        if (userId == null || userId.isBlank()) {
            throw new IllegalArgumentException("User ID must not be blank");
        }
        return balances.getOrDefault(userId, BigDecimal.ZERO);
    }

    public static class InsufficientFundsException extends Exception {
        public InsufficientFundsException(String message) {
            super(message);
        }
    }
}
