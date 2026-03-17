import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import * as userService from '../services/userService.js';
import * as authService from '../services/authService.js';

const router = Router();

router.post(
  '/register',
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string') {
      throw new AppError('Email is required', 400);
    }

    if (!password || typeof password !== 'string') {
      throw new AppError('Password is required', 400);
    }

    const user = await userService.createUser(email, password);

    res.status(201).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
        },
      },
    });
  })
);

router.post(
  '/login',
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string') {
      throw new AppError('Email is required', 400);
    }

    if (!password || typeof password !== 'string') {
      throw new AppError('Password is required', 400);
    }

    const tokens = await authService.login(email, password);

    res.status(200).json({
      status: 'success',
      data: tokens,
    });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const user = userService.getUserById(userId);

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      },
    });
  })
);

router.put(
  '/me/password',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || typeof currentPassword !== 'string') {
      throw new AppError('Current password is required', 400);
    }

    if (!newPassword || typeof newPassword !== 'string') {
      throw new AppError('New password is required', 400);
    }

    await userService.updatePassword(req.user!.userId, currentPassword, newPassword);

    authService.logout(req.user!.userId);

    res.status(200).json({
      status: 'success',
      message: 'Password updated successfully. Please log in again.',
    });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new AppError('Refresh token is required', 400);
    }

    const result = authService.refreshToken(refreshToken);

    res.status(200).json({
      status: 'success',
      data: result,
    });
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    authService.logout(req.user!.userId);

    res.status(200).json({
      status: 'success',
      message: 'Logged out successfully',
    });
  })
);

export default router;
