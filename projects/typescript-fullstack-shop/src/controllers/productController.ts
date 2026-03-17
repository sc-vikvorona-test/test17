import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import * as productService from '../services/productService.js';
import * as inventoryService from '../services/inventoryService.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { category, minPrice, maxPrice, limit, offset, q } = req.query;

    if (q && typeof q === 'string') {
      const results = productService.searchProducts(q);
      return res.status(200).json({
        status: 'success',
        data: {
          products: results,
          total: results.length,
        },
      });
    }

    const filters: productService.ProductFilters = {};

    if (category && typeof category === 'string') {
      filters.category = category;
    }

    if (minPrice !== undefined) {
      const parsed = parseFloat(String(minPrice));
      if (isNaN(parsed) || parsed < 0) throw new AppError('minPrice must be a non-negative number', 400);
      filters.minPrice = parsed;
    }

    if (maxPrice !== undefined) {
      const parsed = parseFloat(String(maxPrice));
      if (isNaN(parsed) || parsed < 0) throw new AppError('maxPrice must be a non-negative number', 400);
      filters.maxPrice = parsed;
    }

    if (limit !== undefined) {
      const parsed = parseInt(String(limit), 10);
      if (isNaN(parsed) || parsed <= 0) throw new AppError('limit must be a positive integer', 400);
      filters.limit = Math.min(parsed, 100);
    }

    if (offset !== undefined) {
      const parsed = parseInt(String(offset), 10);
      if (isNaN(parsed) || parsed < 0) throw new AppError('offset must be a non-negative integer', 400);
      filters.offset = parsed;
    }

    const result = productService.getProducts(filters);

    res.status(200).json({
      status: 'success',
      data: result,
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const product = productService.getProductById(req.params.id);
    const inventory = inventoryService.getInventoryStatus(product.id);

    res.status(200).json({
      status: 'success',
      data: {
        product,
        inventory: {
          availableStock: inventory.availableStock,
          inStock: inventory.availableStock > 0,
        },
      },
    });
  })
);

export default router;
