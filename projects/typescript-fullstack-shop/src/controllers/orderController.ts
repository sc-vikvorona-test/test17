import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import * as orderService from '../services/orderService.js';
import * as paymentService from '../services/paymentService.js';

const router = Router();

router.use(requireAuth);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { shippingAddress } = req.body;

    if (!shippingAddress || typeof shippingAddress !== 'object') {
      throw new AppError('shippingAddress is required', 400);
    }

    const { street, city, state, postalCode, country } = shippingAddress;

    if (!street || !city || !state || !postalCode || !country) {
      throw new AppError('shippingAddress must include street, city, state, postalCode, and country', 400);
    }

    const order = await orderService.createOrder(userId, {
      shippingAddress: { street, city, state, postalCode, country },
    });

    res.status(201).json({
      status: 'success',
      data: { order },
    });
  })
);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const userOrders = orderService.getOrdersByUser(userId);

    res.status(200).json({
      status: 'success',
      data: {
        orders: userOrders,
        total: userOrders.length,
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const order = orderService.getOrderById(req.params.id);

    if (order.userId !== userId && req.user!.role !== 'admin') {
      throw new AppError('You do not have permission to view this order', 403);
    }

    const payment = order.paymentId
      ? paymentService.getPaymentById(order.paymentId)
      : undefined;

    res.status(200).json({
      status: 'success',
      data: {
        order,
        payment: payment ?? null,
      },
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const cancelledOrder = await orderService.cancelOrder(req.params.id, userId);

    res.status(200).json({
      status: 'success',
      data: { order: cancelledOrder },
    });
  })
);

export default router;
