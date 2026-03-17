import { Router } from 'express';
import userRouter from './controllers/userController.js';
import cartRouter from './controllers/cartController.js';
import orderRouter from './controllers/orderController.js';
import productRouter from './controllers/productController.js';
import notificationRouter from './controllers/notificationController.js';

const router = Router();

router.use('/auth', userRouter);
router.use('/cart', cartRouter);
router.use('/orders', orderRouter);
router.use('/products', productRouter);
router.use('/notifications', notificationRouter);

export default router;
