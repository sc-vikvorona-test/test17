package com.example.payment;

import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class PaymentServiceTest {

    private PaymentRepository paymentRepository;
    private PaymentService paymentService;

    @BeforeEach
    void setUp() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:testdb_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
        dataSource.setUser("sa");
        dataSource.setPassword("");
        paymentRepository = new PaymentRepository(dataSource);
        paymentService = new PaymentService(paymentRepository);
    }

    @Test
    void processPayment_validInput_returnsCompletedPayment() throws PaymentService.PaymentProcessingException {
        Payment payment = paymentService.processPayment("Acme Corp", new BigDecimal("99.99"), "USD");

        assertNotNull(payment);
        assertNotNull(payment.getId());
        assertEquals("Acme Corp", payment.getMerchantName());
        assertEquals(new BigDecimal("99.99"), payment.getAmount());
        assertEquals("USD", payment.getCurrency());
        assertEquals(Payment.Status.COMPLETED, payment.getStatus());
        assertNotNull(payment.getCreatedAt());
    }

    @Test
    void processPayment_negativeAmount_throwsException() {
        PaymentService.PaymentProcessingException ex = assertThrows(
                PaymentService.PaymentProcessingException.class,
                () -> paymentService.processPayment("Acme Corp", new BigDecimal("-10.00"), "USD")
        );
        assertTrue(ex.getMessage().contains("amount must be positive"));
    }

    @Test
    void processPayment_blankMerchant_throwsException() {
        PaymentService.PaymentProcessingException ex = assertThrows(
                PaymentService.PaymentProcessingException.class,
                () -> paymentService.processPayment("  ", new BigDecimal("50.00"), "EUR")
        );
        assertTrue(ex.getMessage().contains("Merchant name"));
    }

    @Test
    void processRefund_completedPayment_returnsRefundedPayment() throws PaymentService.PaymentProcessingException {
        Payment original = paymentService.processPayment("Shop X", new BigDecimal("200.00"), "GBP");

        Payment refunded = paymentService.processRefund(original.getId());

        assertNotNull(refunded);
        assertEquals(original.getId(), refunded.getId());
        assertEquals(Payment.Status.REFUNDED, refunded.getStatus());
    }

    @Test
    void processRefund_nonexistentPayment_throwsException() {
        PaymentService.PaymentProcessingException ex = assertThrows(
                PaymentService.PaymentProcessingException.class,
                () -> paymentService.processRefund("non-existent-id")
        );
        assertTrue(ex.getMessage().contains("Payment not found"));
    }

    @Test
    void processRefund_alreadyRefundedPayment_throwsException() throws PaymentService.PaymentProcessingException {
        Payment payment = paymentService.processPayment("Merchant Y", new BigDecimal("30.00"), "USD");
        paymentService.processRefund(payment.getId());

        PaymentService.PaymentProcessingException ex = assertThrows(
                PaymentService.PaymentProcessingException.class,
                () -> paymentService.processRefund(payment.getId())
        );
        assertTrue(ex.getMessage().contains("cannot be refunded"));
    }

    @Test
    void getPaymentsByMerchant_multipleSaved_returnsAll() throws PaymentService.PaymentProcessingException {
        paymentService.processPayment("Retailer Z", new BigDecimal("10.00"), "USD");
        paymentService.processPayment("Retailer Z", new BigDecimal("20.00"), "USD");
        paymentService.processPayment("Other Merchant", new BigDecimal("50.00"), "USD");

        List<Payment> payments = paymentService.getPaymentsByMerchant("Retailer Z");

        assertEquals(2, payments.size());
        assertTrue(payments.stream().allMatch(p -> "Retailer Z".equals(p.getMerchantName())));
    }

    @Test
    void getPaymentsByMerchant_noPayments_returnsEmptyList() throws PaymentService.PaymentProcessingException {
        List<Payment> payments = paymentService.getPaymentsByMerchant("Unknown Merchant");
        assertNotNull(payments);
        assertTrue(payments.isEmpty());
    }
}
