package com.example.payment;

import java.math.BigDecimal;
import java.util.List;

public class PaymentController {

    private final PaymentService paymentService;

    public PaymentController(PaymentService paymentService) {
        this.paymentService = paymentService;
    }

    public PaymentResponse handlePaymentRequest(String merchantName, BigDecimal amount, String currency) {
        if (merchantName == null || amount == null || currency == null) {
            return PaymentResponse.failure("BAD_REQUEST", "merchantName, amount, and currency are required");
        }

        try {
            Payment payment = paymentService.processPayment(merchantName, amount, currency);
            return PaymentResponse.success(payment.getId(), "Payment processed successfully");
        } catch (PaymentService.PaymentProcessingException e) {
            return PaymentResponse.failure("PAYMENT_FAILED", e.getMessage());
        }
    }

    public PaymentResponse handleRefundRequest(String paymentId) {
        if (paymentId == null || paymentId.isBlank()) {
            return PaymentResponse.failure("BAD_REQUEST", "paymentId is required");
        }

        try {
            Payment refundedPayment = paymentService.processRefund(paymentId);
            return PaymentResponse.success(refundedPayment.getId(), "Refund processed successfully");
        } catch (PaymentService.PaymentProcessingException e) {
            return PaymentResponse.failure("REFUND_FAILED", e.getMessage());
        }
    }

    public MerchantQueryResponse handleMerchantQuery(String merchantName) {
        if (merchantName == null || merchantName.isBlank()) {
            return MerchantQueryResponse.failure("BAD_REQUEST", "merchantName is required");
        }

        try {
            List<Payment> payments = paymentService.getPaymentsByMerchant(merchantName);
            return MerchantQueryResponse.success(payments);
        } catch (PaymentService.PaymentProcessingException e) {
            return MerchantQueryResponse.failure("QUERY_FAILED", e.getMessage());
        }
    }

    public static class PaymentResponse {
        private final boolean success;
        private final String paymentId;
        private final String message;
        private final String errorCode;

        private PaymentResponse(boolean success, String paymentId, String message, String errorCode) {
            this.success = success;
            this.paymentId = paymentId;
            this.message = message;
            this.errorCode = errorCode;
        }

        public static PaymentResponse success(String paymentId, String message) {
            return new PaymentResponse(true, paymentId, message, null);
        }

        public static PaymentResponse failure(String errorCode, String message) {
            return new PaymentResponse(false, null, message, errorCode);
        }

        public boolean isSuccess() {
            return success;
        }

        public String getPaymentId() {
            return paymentId;
        }

        public String getMessage() {
            return message;
        }

        public String getErrorCode() {
            return errorCode;
        }

        @Override
        public String toString() {
            return "PaymentResponse{success=" + success + ", paymentId='" + paymentId +
                    "', message='" + message + "', errorCode='" + errorCode + "'}";
        }
    }

    public static class MerchantQueryResponse {
        private final boolean success;
        private final List<Payment> payments;
        private final String errorCode;
        private final String message;

        private MerchantQueryResponse(boolean success, List<Payment> payments, String errorCode, String message) {
            this.success = success;
            this.payments = payments;
            this.errorCode = errorCode;
            this.message = message;
        }

        public static MerchantQueryResponse success(List<Payment> payments) {
            return new MerchantQueryResponse(true, payments, null, null);
        }

        public static MerchantQueryResponse failure(String errorCode, String message) {
            return new MerchantQueryResponse(false, null, errorCode, message);
        }

        public boolean isSuccess() {
            return success;
        }

        public List<Payment> getPayments() {
            return payments;
        }

        public String getErrorCode() {
            return errorCode;
        }

        public String getMessage() {
            return message;
        }
    }
}
