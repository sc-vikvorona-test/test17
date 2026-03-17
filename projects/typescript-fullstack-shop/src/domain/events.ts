import { EventEmitter } from 'events';
import { OrderStatus, PaymentStatus } from './types.js';

export type ShopEventType =
  | 'order.placed'
  | 'order.cancelled'
  | 'payment.processed'
  | 'payment.refunded'
  | 'inventory.updated'
  | 'inventory.low_stock';

export interface BaseEvent {
  type: ShopEventType;
  timestamp: Date;
}

export interface OrderPlacedEvent extends BaseEvent {
  type: 'order.placed';
  orderId: string;
  userId: string;
  totalAmount: number;
  itemCount: number;
}

export interface OrderCancelledEvent extends BaseEvent {
  type: 'order.cancelled';
  orderId: string;
  userId: string;
}

export interface PaymentProcessedEvent extends BaseEvent {
  type: 'payment.processed';
  paymentId: string;
  orderId: string;
  userId: string;
  amount: number;
  status: PaymentStatus;
}

export interface PaymentRefundedEvent extends BaseEvent {
  type: 'payment.refunded';
  paymentId: string;
  orderId: string;
  userId: string;
  amount: number;
}

export interface InventoryUpdatedEvent extends BaseEvent {
  type: 'inventory.updated';
  productId: string;
  previousAvailable: number;
  currentAvailable: number;
  delta: number;
}

export interface InventoryLowStockEvent extends BaseEvent {
  type: 'inventory.low_stock';
  productId: string;
  availableStock: number;
  reorderPoint: number;
}

export type ShopEvent =
  | OrderPlacedEvent
  | OrderCancelledEvent
  | PaymentProcessedEvent
  | PaymentRefundedEvent
  | InventoryUpdatedEvent
  | InventoryLowStockEvent;

type EventHandler<T extends ShopEvent> = (event: T) => void | Promise<void>;

class EventBusClass {
  private emitter = new EventEmitter();

  publish<T extends ShopEvent>(event: T): void {
    this.emitter.emit(event.type, event);
  }

  emit<T extends ShopEvent>(event: T): void {
    this.publish(event);
  }

  on<T extends ShopEvent>(eventType: T['type'], handler: EventHandler<T>): void {
    this.emitter.on(eventType, handler as (event: ShopEvent) => void);
  }

  off<T extends ShopEvent>(eventType: T['type'], handler: EventHandler<T>): void {
    this.emitter.off(eventType, handler as (event: ShopEvent) => void);
  }
}

export const eventBus = new EventBusClass();
