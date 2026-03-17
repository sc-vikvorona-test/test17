import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import * as cartService from '../services/cartService.js';
import * as productService from '../services/productService.js';

const router = Router();

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const cart = cartService.getCart(userId);
    const total = cartService.calculateTotal(userId);

    const enrichedItems = cart.map((item) => {
      try {
        const product = productService.getProductById(item.productId);
        return {
          ...item,
          productName: product.name,
          productImageUrl: product.imageUrl,
          currentPrice: product.price,
        };
      } catch {
        return { ...item, productName: 'Product unavailable', productImageUrl: null, currentPrice: null };
      }
    });

    res.status(200).json({
      status: 'success',
      data: {
        items: enrichedItems,
        itemCount: cart.length,
        total,
      },
    });
  })
);

router.post(
  '/items',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { productId, quantity } = req.body;

    if (!productId || typeof productId !== 'string') {
      throw new AppError('productId is required', 400);
    }

    const qty = parseInt(String(quantity), 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new AppError('quantity must be a positive integer', 400);
    }

    const updatedCart = cartService.addToCart(userId, productId, qty);
    const total = cartService.calculateTotal(userId);

    res.status(200).json({
      status: 'success',
      data: {
        items: updatedCart,
        itemCount: updatedCart.length,
        total,
      },
    });
  })
);

router.put(
  '/items/:productId',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { productId } = req.params;
    const { quantity } = req.body;

    const qty = parseInt(String(quantity), 10);
    if (!Number.isInteger(qty) || qty < 0) {
      throw new AppError('quantity must be a non-negative integer', 400);
    }

    const updatedCart = cartService.updateCartItem(userId, productId, qty);
    const total = cartService.calculateTotal(userId);

    res.status(200).json({
      status: 'success',
      data: {
        items: updatedCart,
        itemCount: updatedCart.length,
        total,
      },
    });
  })
);

router.delete(
  '/items/:productId',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { productId } = req.params;

    const updatedCart = cartService.removeFromCart(userId, productId);
    const total = cartService.calculateTotal(userId);

    res.status(200).json({
      status: 'success',
      data: {
        items: updatedCart,
        itemCount: updatedCart.length,
        total,
      },
    });
  })
);

router.delete(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    cartService.clearCart(userId);

    res.status(200).json({
      status: 'success',
      message: 'Cart cleared successfully',
    });
  })
);

export default router;
