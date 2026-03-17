import { CartItem } from '../domain/types.js';
import { AppError } from '../middleware/errorHandler.js';
import * as productService from './productService.js';
import * as inventoryService from './inventoryService.js';

const carts = new Map<string, CartItem[]>();

export function getCart(userId: string): CartItem[] {
  return carts.get(userId) ?? [];
}

export function addToCart(userId: string, productId: string, quantity: number): CartItem[] {
  if (quantity <= 0) {
    throw new AppError('Quantity must be greater than zero', 400);
  }

  const product = productService.getProductById(productId);

  const cart = getCart(userId);
  const existingItem = cart.find((item) => item.productId === productId);
  const currentCartQty = existingItem?.quantity ?? 0;
  const totalRequested = currentCartQty + quantity;

  if (!inventoryService.checkAvailability(productId, totalRequested)) {
    const status = inventoryService.getInventoryStatus(productId);
    throw new AppError(
      `Not enough stock. Requested: ${totalRequested}, available: ${status.availableStock}`,
      409
    );
  }

  let updatedCart: CartItem[];

  if (existingItem) {
    updatedCart = cart.map((item) =>
      item.productId === productId
        ? { ...item, quantity: item.quantity + quantity }
        : item
    );
  } else {
    const newItem: CartItem = {
      productId,
      quantity,
      unitPrice: product.price,
      addedAt: new Date(),
    };
    updatedCart = [...cart, newItem];
  }

  carts.set(userId, updatedCart);
  return updatedCart;
}

export function updateCartItem(userId: string, productId: string, quantity: number): CartItem[] {
  if (quantity < 0) {
    throw new AppError('Quantity cannot be negative', 400);
  }

  if (quantity === 0) {
    return removeFromCart(userId, productId);
  }

  const cart = getCart(userId);
  const existingItem = cart.find((item) => item.productId === productId);

  if (!existingItem) {
    throw new AppError('Item not found in cart', 404);
  }

  if (!inventoryService.checkAvailability(productId, quantity)) {
    const status = inventoryService.getInventoryStatus(productId);
    throw new AppError(
      `Not enough stock. Requested: ${quantity}, available: ${status.availableStock}`,
      409
    );
  }

  const updatedCart = cart.map((item) =>
    item.productId === productId ? { ...item, quantity } : item
  );

  carts.set(userId, updatedCart);
  return updatedCart;
}

export function removeFromCart(userId: string, productId: string): CartItem[] {
  const cart = getCart(userId);
  const updatedCart = cart.filter((item) => item.productId !== productId);

  carts.set(userId, updatedCart);
  return updatedCart;
}

export function clearCart(userId: string): void {
  carts.delete(userId);
}

export function calculateTotal(userId: string): number {
  const cart = getCart(userId);
  return cart.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
}

export function validateCartNotEmpty(userId: string): CartItem[] {
  const cart = getCart(userId);

  if (cart.length === 0) {
    throw new AppError('Cart is empty', 400);
  }

  return cart;
}
