import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import * as notificationService from '../services/notificationService.js';

const router = Router();

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const allNotifications = notificationService.getNotificationsForUser(userId);

    const unreadOnly = req.query.unread === 'true';
    const notifications = unreadOnly
      ? allNotifications.filter((n) => !n.read)
      : allNotifications;

    res.status(200).json({
      status: 'success',
      data: {
        notifications,
        total: notifications.length,
        unreadCount: allNotifications.filter((n) => !n.read).length,
      },
    });
  })
);

router.patch(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { id } = req.params;

    const updated = notificationService.markAsRead(userId, id);

    if (!updated) {
      throw new AppError('Notification not found', 404);
    }

    res.status(200).json({
      status: 'success',
      message: 'Notification marked as read',
    });
  })
);

export default router;
