import { v4 as uuidv4 } from 'uuid';
import { Order, OrderItem, OrderStatus, Address } from '../domain/types.js';
import { eventBus } from '../domain/events.js';
import { AppError } from '../middleware/errorHandler.js';
import * as cartService from './cartService.js';
import * as inventoryService from './inventoryService.js';
import * as paymentService from './paymentService.js';
import * as productService from './productService.js';

const orders = new Map<string, Order>();
const ordersByUser = new Map<string, string[]>();

const reservations = new Map<string, Array<{ productId: string; quantity: number }>>();

export interface CreateOrderInput {
  shippingAddress: Address;
}

export async function createOrder(userId: string, input: CreateOrderInput): Promise<Order> {
  const cartItems = cartService.validateCartNotEmpty(userId);

  const orderItems: OrderItem[] = cartItems.map((cartItem) => {
    const product = productService.getProductById(cartItem.productId);
    return {
      productId: cartItem.productId,
      productName: product.name,
      quantity: cartItem.quantity,
      unitPrice: cartItem.unitPrice,
      subtotal: cartItem.unitPrice * cartItem.quantity,
    };
  });

  const reservedItems: Array<{ productId: string; quantity: number }> = [];

  try {
    for (const item of orderItems) {
      inventoryService.reserveStock(item.productId, item.quantity);
      reservedItems.push({ productId: item.productId, quantity: item.quantity });
    }
  } catch (err) {
    for (const reserved of reservedItems) {
      inventoryService.releaseReservation(reserved.productId, reserved.quantity);
    }
    throw err;
  }

  const totalAmount = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
  const now = new Date();
  const orderId = uuidv4();

  const order: Order = {
    id: orderId,
    userId,
    items: orderItems,
    status: OrderStatus.Pending,
    totalAmount,
    shippingAddress: input.shippingAddress,
    paymentId: null,
    createdAt: now,
    updatedAt: now,
  };

  orders.set(orderId, order);
  reservations.set(orderId, reservedItems);

  const userOrders = ordersByUser.get(userId) ?? [];
  ordersByUser.set(userId, [...userOrders, orderId]);

  eventBus.emit({
    type: 'order.placed',
    timestamp: new Date(),
    orderId,
    userId,
    totalAmount,
    itemCount: orderItems.length,
  });

  let payment;
  try {
    payment = await paymentService.processPayment(orderId, totalAmount, userId);
  } catch (err) {
    const failedOrder: Order = {
      ...order,
      status: OrderStatus.Cancelled,
      updatedAt: new Date(),
    };
    orders.set(orderId, failedOrder);

    for (const reserved of reservedItems) {
      inventoryService.releaseReservation(reserved.productId, reserved.quantity);
    }
    reservations.delete(orderId);

    throw err;
  }

  for (const reserved of reservedItems) {
    inventoryService.confirmReservation(reserved.productId, reserved.quantity);
  }
  reservations.delete(orderId);

  cartService.clearCart(userId);

  const confirmedOrder: Order = {
    ...order,
    status: OrderStatus.Confirmed,
    paymentId: payment.id,
    updatedAt: new Date(),
  };

  orders.set(orderId, confirmedOrder);
  return confirmedOrder;
}

export function getOrdersByUser(userId: string): Order[] {
  const userOrderIds = ordersByUser.get(userId) ?? [];
  return userOrderIds
    .map((id) => orders.get(id))
    .filter((order): order is Order => order !== undefined);
}

export function getOrderById(id: string): Order {
  const order = orders.get(id);

  if (!order) {
    throw new AppError(`Order '${id}' not found`, 404);
  }

  return order;
}

export async function cancelOrder(orderId: string, userId: string): Promise<Order> {
  const order = getOrderById(orderId);

  if (order.userId !== userId) {
    throw new AppError('You do not have permission to cancel this order', 403);
  }

  const cancellableStatuses: OrderStatus[] = [OrderStatus.Pending, OrderStatus.Confirmed];

  if (!cancellableStatuses.includes(order.status)) {
    throw new AppError(
      `Cannot cancel order with status '${order.status}'. Only pending or confirmed orders can be cancelled.`,
      400
    );
  }

  const reserved = reservations.get(orderId);
  if (reserved) {
    for (const item of reserved) {
      inventoryService.releaseReservation(item.productId, item.quantity);
    }
    reservations.delete(orderId);
  } else {
    for (const item of order.items) {
      inventoryService.releaseReservation(item.productId, item.quantity);
    }
  }

  if (order.paymentId) {
    const payment = paymentService.getPaymentById(order.paymentId);
    if (payment) {
      await paymentService.refundPayment(payment.id);
    }
  }

  const cancelledOrder: Order = {
    ...order,
    status: OrderStatus.Cancelled,
    updatedAt: new Date(),
  };

  orders.set(orderId, cancelledOrder);

  eventBus.emit({
    type: 'order.cancelled',
    timestamp: new Date(),
    orderId,
    userId,
  });

  return cancelledOrder;
}
