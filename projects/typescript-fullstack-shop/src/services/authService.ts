import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { JwtPayload } from '../domain/types.js';
import { AppError } from '../middleware/errorHandler.js';
import * as userService from './userService.js';

const TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

const refreshTokens = new Map<string, { userId: string; expiresAt: Date }>();
const invalidatedTokens = new Set<string>();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new AppError('JWT_SECRET environment variable is not set', 500);
  }
  return secret;
}

export async function login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  const user = await userService.validateCredentials(email, password);

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const secret = getJwtSecret();
  const accessToken = jwt.sign(payload, secret, { expiresIn: TOKEN_EXPIRY });

  const refreshTokenId = uuidv4();
  const refreshToken = jwt.sign({ ...payload, tokenId: refreshTokenId }, secret, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  refreshTokens.set(refreshTokenId, { userId: user.id, expiresAt });

  return { accessToken, refreshToken };
}

export function refreshToken(token: string): { accessToken: string } {
  const secret = getJwtSecret();

  let decoded: JwtPayload & { tokenId?: string };
  try {
    decoded = jwt.verify(token, secret) as JwtPayload & { tokenId?: string };
  } catch {
    throw new AppError('Invalid or expired refresh token', 401);
  }

  if (!decoded.tokenId) {
    throw new AppError('Invalid refresh token format', 401);
  }

  const stored = refreshTokens.get(decoded.tokenId);

  if (!stored || stored.userId !== decoded.userId) {
    throw new AppError('Refresh token not found or revoked', 401);
  }

  if (stored.expiresAt < new Date()) {
    refreshTokens.delete(decoded.tokenId);
    throw new AppError('Refresh token has expired', 401);
  }

  const user = userService.getUserById(decoded.userId);
  if (!user) {
    throw new AppError('User not found', 404);
  }

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = jwt.sign(payload, secret, { expiresIn: TOKEN_EXPIRY });

  return { accessToken };
}

export function logout(userId: string, tokenId?: string): void {
  if (tokenId) {
    refreshTokens.delete(tokenId);
    return;
  }

  for (const [id, data] of refreshTokens.entries()) {
    if (data.userId === userId) {
      refreshTokens.delete(id);
    }
  }
}
