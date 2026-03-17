import { v4 as uuidv4 } from 'uuid';
import { Product } from '../domain/types.js';
import { AppError } from '../middleware/errorHandler.js';

const products = new Map<string, Product>();

function seed(): void {
  const now = new Date();
  const sampleProducts: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>[] = [
    {
      name: 'Wireless Noise-Cancelling Headphones',
      description: 'Premium over-ear headphones with 30-hour battery life and active noise cancellation.',
      price: 249.99,
      category: 'electronics',
      imageUrl: 'https://example.com/images/headphones-wh1000.jpg',
      sku: 'ELEC-WH-1000',
    },
    {
      name: 'Mechanical Keyboard',
      description: 'Tenkeyless mechanical keyboard with Cherry MX Brown switches and RGB backlighting.',
      price: 129.99,
      category: 'electronics',
      imageUrl: 'https://example.com/images/keyboard-tkl.jpg',
      sku: 'ELEC-KB-TKL',
    },
    {
      name: 'Ergonomic Office Chair',
      description: 'Fully adjustable ergonomic chair with lumbar support and breathable mesh back.',
      price: 449.00,
      category: 'furniture',
      imageUrl: 'https://example.com/images/chair-ergo.jpg',
      sku: 'FURN-CH-ERG',
    },
    {
      name: 'Standing Desk',
      description: 'Electric height-adjustable standing desk with memory presets.',
      price: 699.00,
      category: 'furniture',
      imageUrl: 'https://example.com/images/desk-stand.jpg',
      sku: 'FURN-DK-STD',
    },
    {
      name: 'USB-C Hub 10-in-1',
      description: 'Multi-port USB-C hub with HDMI, Ethernet, SD card, and USB-A ports.',
      price: 59.99,
      category: 'electronics',
      imageUrl: 'https://example.com/images/hub-usbc.jpg',
      sku: 'ELEC-HUB-C10',
    },
  ];

  for (const data of sampleProducts) {
    const product: Product = {
      ...data,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };
    products.set(product.id, product);
  }
}

seed();

export interface ProductFilters {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  offset?: number;
}

export function getProducts(filters?: ProductFilters): { products: Product[]; total: number } {
  let result = Array.from(products.values());

  if (filters?.category) {
    result = result.filter((p) => p.category === filters.category);
  }

  if (filters?.minPrice !== undefined) {
    result = result.filter((p) => p.price >= filters.minPrice!);
  }

  if (filters?.maxPrice !== undefined) {
    result = result.filter((p) => p.price <= filters.maxPrice!);
  }

  const total = result.length;
  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 50;

  return {
    products: result.slice(offset, offset + limit),
    total,
  };
}

export function getProductById(id: string): Product {
  const product = products.get(id);

  if (!product) {
    throw new AppError(`Product with id '${id}' not found`, 404);
  }

  return product;
}

export function updateStock(productId: string, delta: number): Product {
  const product = getProductById(productId);
  return product;
}

export function searchProducts(query: string): Product[] {
  const normalizedQuery = query.toLowerCase().trim();

  if (!normalizedQuery) {
    return [];
  }

  return Array.from(products.values()).filter(
    (p) =>
      p.name.toLowerCase().includes(normalizedQuery) ||
      p.description.toLowerCase().includes(normalizedQuery) ||
      p.category.toLowerCase().includes(normalizedQuery) ||
      p.sku.toLowerCase().includes(normalizedQuery)
  );
}

export function getAllProductIds(): string[] {
  return Array.from(products.keys());
}
