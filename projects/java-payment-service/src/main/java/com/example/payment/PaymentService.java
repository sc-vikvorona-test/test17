package com.example.payment;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

public class PaymentService {

    private final PaymentRepository paymentRepository;

    public PaymentService(PaymentRepository paymentRepository) {
        this.paymentRepository = paymentRepository;
    }

    public Payment processPayment(String merchantName, BigDecimal amount, String currency) throws PaymentProcessingException {
        if (merchantName == null || merchantName.isBlank()) {
            throw new PaymentProcessingException("Merchant name must not be blank");
        }
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new PaymentProcessingException("Payment amount must be positive");
        }
        if (currency == null || currency.isBlank()) {
            throw new PaymentProcessingException("Currency must not be blank");
        }

        Payment payment = Payment.builder()
                .id(UUID.randomUUID().toString())
                .merchantName(merchantName)
                .amount(amount)
                .currency(currency.toUpperCase())
                .status(Payment.Status.COMPLETED)
                .createdAt(LocalDateTime.now())
                .build();

        return paymentRepository.save(payment);
    }

    public Payment processRefund(String paymentId) throws PaymentProcessingException {
        if (paymentId == null || paymentId.isBlank()) {
            throw new PaymentProcessingException("Payment ID must not be blank");
        }

        Payment payment = paymentRepository.findById(paymentId)
                .orElseThrow(() -> new PaymentProcessingException("Payment not found: " + paymentId));

        if (payment.getStatus() != Payment.Status.COMPLETED) {
            throw new PaymentProcessingException(
                    "Payment cannot be refunded. Current status: " + payment.getStatus());
        }

        paymentRepository.updateStatus(paymentId, Payment.Status.REFUNDED.name());

        return paymentRepository.findById(paymentId)
                .orElseThrow(() -> new PaymentProcessingException("Failed to retrieve updated payment: " + paymentId));
    }

    public List<Payment> getPaymentsByMerchant(String merchant) throws PaymentProcessingException {
        if (merchant == null || merchant.isBlank()) {
            throw new PaymentProcessingException("Merchant name must not be blank");
        }
        return paymentRepository.findByMerchant(merchant);
    }

    public static class PaymentProcessingException extends Exception {
        public PaymentProcessingException(String message) {
            super(message);
        }

        public PaymentProcessingException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
