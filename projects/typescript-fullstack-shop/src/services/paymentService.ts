import { v4 as uuidv4 } from 'uuid';
import { Payment, PaymentStatus, OrderStatus } from '../domain/types.js';
import { eventBus } from '../domain/events.js';
import { AppError } from '../middleware/errorHandler.js';

const payments = new Map<string, Payment>();
const paymentsByOrder = new Map<string, string>();

function simulatePaymentGateway(amount: number): { success: boolean; transactionId: string | null } {
  const success = Math.random() > 0.05;
  return {
    success,
    transactionId: success ? `txn_${uuidv4().replace(/-/g, '')}` : null,
  };
}

export async function processPayment(
  orderId: string,
  amount: number,
  userId: string
): Promise<Payment> {
  if (paymentsByOrder.has(orderId)) {
    throw new AppError(`Payment already exists for order '${orderId}'`, 409);
  }

  if (amount <= 0) {
    throw new AppError('Payment amount must be greater than zero', 400);
  }

  const now = new Date();
  const paymentId = uuidv4();

  const pendingPayment: Payment = {
    id: paymentId,
    orderId,
    userId,
    amount,
    status: PaymentStatus.Pending,
    transactionId: null,
    createdAt: now,
    updatedAt: now,
  };

  payments.set(paymentId, pendingPayment);
  paymentsByOrder.set(orderId, paymentId);

  const gatewayResult = simulatePaymentGateway(amount);

  const finalStatus = gatewayResult.success ? PaymentStatus.Captured : PaymentStatus.Failed;

  const finalPayment: Payment = {
    ...pendingPayment,
    status: finalStatus,
    transactionId: gatewayResult.transactionId,
    updatedAt: new Date(),
  };

  payments.set(paymentId, finalPayment);

  eventBus.emit({
    type: 'payment.processed',
    timestamp: new Date(),
    paymentId,
    orderId,
    userId,
    amount,
    status: finalStatus,
  });

  if (!gatewayResult.success) {
    throw new AppError('Payment processing failed. Please try again or use a different payment method.', 402);
  }

  return finalPayment;
}

export async function refundPayment(paymentId: string): Promise<Payment> {
  const payment = payments.get(paymentId);

  if (!payment) {
    throw new AppError(`Payment '${paymentId}' not found`, 404);
  }

  if (payment.status !== PaymentStatus.Captured) {
    throw new AppError(`Cannot refund payment with status '${payment.status}'`, 400);
  }

  const refundedPayment: Payment = {
    ...payment,
    status: PaymentStatus.Refunded,
    updatedAt: new Date(),
  };

  payments.set(paymentId, refundedPayment);

  eventBus.emit({
    type: 'payment.refunded',
    timestamp: new Date(),
    paymentId,
    orderId: payment.orderId,
    userId: payment.userId,
    amount: payment.amount,
  });

  return refundedPayment;
}

export function getPaymentByOrder(orderId: string): Payment | undefined {
  const paymentId = paymentsByOrder.get(orderId);
  if (!paymentId) return undefined;
  return payments.get(paymentId);
}

export function getPaymentById(paymentId: string): Payment | undefined {
  return payments.get(paymentId);
}
