import { v4 as uuidv4 } from 'uuid';
import { Notification } from '../domain/types.js';
import { eventBus, OrderPlacedEvent, PaymentProcessedEvent, OrderCancelledEvent } from '../domain/events.js';
import { PaymentStatus } from '../domain/types.js';

const notifications = new Map<string, Notification[]>();

function storeNotification(notification: Notification): void {
  const userNotifications = notifications.get(notification.userId) ?? [];
  notifications.set(notification.userId, [...userNotifications, notification]);
}

export function sendOrderConfirmation(userId: string, orderId: string): Notification {
  const notification: Notification = {
    id: uuidv4(),
    userId,
    type: 'order_confirmation',
    subject: 'Order Confirmed',
    body: `Your order #${orderId} has been confirmed and is being processed.`,
    read: false,
    createdAt: new Date(),
  };

  storeNotification(notification);
  return notification;
}

export function sendPaymentConfirmation(userId: string, amount: number): Notification {
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  const notification: Notification = {
    id: uuidv4(),
    userId,
    type: 'payment_confirmation',
    subject: 'Payment Successful',
    body: `Your payment of ${formatted} has been successfully processed.`,
    read: false,
    createdAt: new Date(),
  };

  storeNotification(notification);
  return notification;
}

export function sendShippingUpdate(userId: string, orderId: string, status: string): Notification {
  const notification: Notification = {
    id: uuidv4(),
    userId,
    type: 'shipping_update',
    subject: 'Shipping Update',
    body: `Your order #${orderId} status has been updated to: ${status}.`,
    read: false,
    createdAt: new Date(),
  };

  storeNotification(notification);
  return notification;
}

export function getNotificationsForUser(userId: string): Notification[] {
  return notifications.get(userId) ?? [];
}

export function markAsRead(userId: string, notificationId: string): boolean {
  const userNotifications = notifications.get(userId);

  if (!userNotifications) return false;

  const index = userNotifications.findIndex((n) => n.id === notificationId);

  if (index === -1) return false;

  const updated = [...userNotifications];
  updated[index] = { ...updated[index], read: true };
  notifications.set(userId, updated);

  return true;
}

function registerEventListeners(): void {
  eventBus.on<OrderPlacedEvent>('order.placed', (event) => {
    sendOrderConfirmation(event.userId, event.orderId);
  });

  eventBus.on<PaymentProcessedEvent>('payment.processed', (event) => {
    if (event.status === PaymentStatus.Captured) {
      sendPaymentConfirmation(event.userId, event.amount);
    }
  });

  eventBus.on<OrderCancelledEvent>('order.cancelled', (event) => {
    const notification: Notification = {
      id: uuidv4(),
      userId: event.userId,
      type: 'general',
      subject: 'Order Cancelled',
      body: `Your order #${event.orderId} has been cancelled. Any charges have been refunded.`,
      read: false,
      createdAt: new Date(),
    };
    storeNotification(notification);
  });
}

registerEventListeners();
