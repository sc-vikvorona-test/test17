import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../domain/types.js';
import { AppError } from '../middleware/errorHandler.js';

const BCRYPT_ROUNDS = 12;

const users = new Map<string, User>();
const usersByEmail = new Map<string, User>();

export async function createUser(email: string, password: string, role: 'customer' | 'admin' = 'customer'): Promise<User> {
  const normalizedEmail = email.toLowerCase().trim();

  if (usersByEmail.has(normalizedEmail)) {
    throw new AppError('Email already in use', 409);
  }

  if (password.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const now = new Date();
  const user: User = {
    id: uuidv4(),
    email: normalizedEmail,
    passwordHash,
    role,
    createdAt: now,
    updatedAt: now,
  };

  users.set(user.id, user);
  usersByEmail.set(normalizedEmail, user);

  return user;
}

export function findByEmail(email: string): User | undefined {
  return usersByEmail.get(email.toLowerCase().trim());
}

export async function validateCredentials(email: string, password: string): Promise<User> {
  const user = findByEmail(email);

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);

  if (!isValid) {
    throw new AppError('Invalid email or password', 401);
  }

  return user;
}

export function getUserById(id: string): User | undefined {
  return users.get(id);
}

export async function updatePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = users.get(userId);

  if (!user) {
    throw new AppError('User not found', 404);
  }

  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);

  if (!isValid) {
    throw new AppError('Current password is incorrect', 401);
  }

  if (newPassword.length < 8) {
    throw new AppError('New password must be at least 8 characters', 400);
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  const updatedUser: User = {
    ...user,
    passwordHash: newHash,
    updatedAt: new Date(),
  };

  users.set(userId, updatedUser);
  usersByEmail.set(updatedUser.email, updatedUser);
}
