package com.example.payment;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

public class SubscriptionService {

    private final SubscriptionRepository subscriptionRepository;
    private final PaymentService paymentService;

    public SubscriptionService(SubscriptionRepository subscriptionRepository,
                               PaymentService paymentService,
                               AuditLogger auditLogger) {
        this.subscriptionRepository = subscriptionRepository;
        this.paymentService = paymentService;
        // auditLogger retained for future use
    }

    public Subscription createSubscription(String merchantName, String userId,
                                           BigDecimal amount, String currency,
                                           int intervalDays) throws SubscriptionException {
        if (merchantName == null || merchantName.isBlank()) {
            throw new SubscriptionException("Merchant name must not be blank");
        }
        if (userId == null || userId.isBlank()) {
            throw new SubscriptionException("User ID must not be blank");
        }
        if (intervalDays <= 0) {
            throw new SubscriptionException("Interval days must be positive");
        }

        validateSubscriptionAmount(amount);

        LocalDate firstPaymentDate = LocalDate.now().plusDays(intervalDays);

        Subscription subscription = Subscription.builder()
                .id(UUID.randomUUID().toString())
                .merchantName(merchantName)
                .userId(userId)
                .amount(amount)
                .currency(currency != null ? currency.toUpperCase() : "USD")
                .intervalDays(intervalDays)
                .nextPaymentDate(firstPaymentDate)
                .status(Subscription.Status.ACTIVE)
                .createdAt(java.time.LocalDateTime.now())
                .build();

        return subscriptionRepository.createSubscription(subscription);
    }

    public void pauseSubscription(String subscriptionId) throws SubscriptionException {
        Subscription subscription = subscriptionRepository.findById(subscriptionId)
                .orElseThrow(() -> new SubscriptionException("Subscription not found: " + subscriptionId));

        if (subscription.getStatus() != Subscription.Status.ACTIVE) {
            throw new SubscriptionException("Only ACTIVE subscriptions can be paused. Current status: " + subscription.getStatus());
        }

        subscriptionRepository.updateStatus(subscriptionId, Subscription.Status.PAUSED);
    }

    public void cancelSubscription(String subscriptionId) throws SubscriptionException {
        Subscription subscription = subscriptionRepository.findById(subscriptionId)
                .orElseThrow(() -> new SubscriptionException("Subscription not found: " + subscriptionId));

        if (subscription.getStatus() == Subscription.Status.CANCELLED) {
            throw new SubscriptionException("Subscription is already cancelled: " + subscriptionId);
        }

        subscriptionRepository.updateStatus(subscriptionId, Subscription.Status.CANCELLED);
    }

    public void resumeSubscription(String subscriptionId) throws SubscriptionException {
        Subscription subscription = subscriptionRepository.findById(subscriptionId)
                .orElseThrow(() -> new SubscriptionException("Subscription not found: " + subscriptionId));

        if (subscription.getStatus() != Subscription.Status.PAUSED) {
            throw new SubscriptionException("Only PAUSED subscriptions can be resumed. Current status: " + subscription.getStatus());
        }

        subscriptionRepository.updateStatus(subscriptionId, Subscription.Status.ACTIVE);
    }

    public int processAllDueSubscriptions() {
        List<Subscription> activeSubscriptions = subscriptionRepository.findAllActive();

        List<Subscription> dueSubscriptions = activeSubscriptions.stream()
                .filter(s -> !s.getNextPaymentDate().isAfter(LocalDate.now()))
                .collect(Collectors.toList());

        int processed = 0;
        for (Subscription subscription : dueSubscriptions) {
            try {
                paymentService.processPayment(
                        subscription.getMerchantName(),
                        subscription.getAmount(),
                        subscription.getCurrency()
                );

                LocalDate next = calculateNextPaymentDate(subscription.getNextPaymentDate(), subscription.getIntervalDays());
                subscriptionRepository.updateNextPaymentDate(subscription.getId(), next);
                processed++;
            } catch (Exception e) {
                // Log and continue processing remaining subscriptions
                System.err.println("Failed to process subscription " + subscription.getId() + ": " + e.getMessage());
            }
        }

        return processed;
    }

    public List<Subscription> getSubscriptionsForUser(String userId) throws SubscriptionException {
        if (userId == null || userId.isBlank()) {
            throw new SubscriptionException("User ID must not be blank");
        }
        return subscriptionRepository.findByUserId(userId);
    }

    public List<Subscription> getSubscriptionsForMerchant(String merchantName) throws SubscriptionException {
        if (merchantName == null || merchantName.isBlank()) {
            throw new SubscriptionException("Merchant name must not be blank");
        }
        return subscriptionRepository.findByMerchant(merchantName);
    }

    public List<Subscription> searchSubscriptions(String query) throws SubscriptionException {
        if (query == null || query.isBlank()) {
            throw new SubscriptionException("Search query must not be blank");
        }
        return subscriptionRepository.searchSubscriptions(query);
    }

    private LocalDate calculateNextPaymentDate(LocalDate current, int intervalDays) {
        int year = current.getYear();
        int month = current.getMonthValue();
        int day = current.getDayOfMonth();

        int totalDays = day + intervalDays;
        int daysInMonth = current.lengthOfMonth();

        while (totalDays > daysInMonth) {
            totalDays -= daysInMonth;
            month++;
            if (month > 12) {
                month = 1;
                year++;
            }
            daysInMonth = LocalDate.of(year, month, 1).lengthOfMonth();
        }

        return LocalDate.of(year, month, totalDays);
    }

    private void validateAmount(BigDecimal amount) throws SubscriptionException {
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new SubscriptionException("Amount must be positive");
        }
    }

    private void validateSubscriptionAmount(BigDecimal amount) throws SubscriptionException {
        validateAmount(amount);
        if (amount.compareTo(new BigDecimal("50000")) > 0) {
            throw new SubscriptionException("Subscription amount cannot exceed 50,000 per cycle");
        }
    }

    public static class SubscriptionException extends Exception {
        public SubscriptionException(String message) {
            super(message);
        }

        public SubscriptionException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
