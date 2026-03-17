import { InventoryItem } from '../domain/types.js';
import { eventBus } from '../domain/events.js';
import { AppError } from '../middleware/errorHandler.js';
import * as productService from './productService.js';

const inventory = new Map<string, InventoryItem>();

const DEFAULT_STOCK = 100;
const DEFAULT_REORDER_POINT = 10;

function getOrCreateInventory(productId: string): InventoryItem {
  if (!inventory.has(productId)) {
    productService.getProductById(productId);

    const item: InventoryItem = {
      productId,
      totalStock: DEFAULT_STOCK,
      availableStock: DEFAULT_STOCK,
      reservedStock: 0,
      reorderPoint: DEFAULT_REORDER_POINT,
      updatedAt: new Date(),
    };

    inventory.set(productId, item);
  }

  return inventory.get(productId)!;
}

export function checkAvailability(productId: string, quantity: number): boolean {
  const item = getOrCreateInventory(productId);
  return item.availableStock >= quantity;
}

export function reserveStock(productId: string, quantity: number): InventoryItem {
  const item = getOrCreateInventory(productId);

  if (item.availableStock < quantity) {
    throw new AppError(
      `Insufficient stock for product '${productId}'. Requested: ${quantity}, available: ${item.availableStock}`,
      409
    );
  }

  const previousAvailable = item.availableStock;

  const updatedItem: InventoryItem = {
    ...item,
    availableStock: item.availableStock - quantity,
    reservedStock: item.reservedStock + quantity,
    updatedAt: new Date(),
  };

  inventory.set(productId, updatedItem);

  eventBus.emit({
    type: 'inventory.updated',
    timestamp: new Date(),
    productId,
    previousAvailable,
    currentAvailable: updatedItem.availableStock,
    delta: -quantity,
  });

  if (updatedItem.availableStock <= updatedItem.reorderPoint) {
    eventBus.emit({
      type: 'inventory.low_stock',
      timestamp: new Date(),
      productId,
      availableStock: updatedItem.availableStock,
      reorderPoint: updatedItem.reorderPoint,
    });
  }

  return updatedItem;
}

export function releaseReservation(productId: string, quantity: number): InventoryItem {
  const item = getOrCreateInventory(productId);

  const releaseAmount = Math.min(quantity, item.reservedStock);
  const previousAvailable = item.availableStock;

  const updatedItem: InventoryItem = {
    ...item,
    availableStock: item.availableStock + releaseAmount,
    reservedStock: item.reservedStock - releaseAmount,
    updatedAt: new Date(),
  };

  inventory.set(productId, updatedItem);

  eventBus.emit({
    type: 'inventory.updated',
    timestamp: new Date(),
    productId,
    previousAvailable,
    currentAvailable: updatedItem.availableStock,
    delta: releaseAmount,
  });

  return updatedItem;
}

export function confirmReservation(productId: string, quantity: number): InventoryItem {
  const item = getOrCreateInventory(productId);

  const confirmAmount = Math.min(quantity, item.reservedStock);

  const updatedItem: InventoryItem = {
    ...item,
    totalStock: item.totalStock - confirmAmount,
    reservedStock: item.reservedStock - confirmAmount,
    updatedAt: new Date(),
  };

  inventory.set(productId, updatedItem);
  return updatedItem;
}

export function getInventoryStatus(productId: string): InventoryItem {
  return getOrCreateInventory(productId);
}

export function setReorderPoint(productId: string, reorderPoint: number): InventoryItem {
  const item = getOrCreateInventory(productId);

  const updatedItem: InventoryItem = {
    ...item,
    reorderPoint,
    updatedAt: new Date(),
  };

  inventory.set(productId, updatedItem);
  return updatedItem;
}
