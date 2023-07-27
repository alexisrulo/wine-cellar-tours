import { CookieOptions, NextFunction, Request, Response } from 'express';
import { Prisma, UserRole } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

import { envVars } from '../configs/env.config';
import { CreateUserType, LoginUser } from '../schemas/user.schema';
import { createUser, getUser, signTokens } from '../services/user.service';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  InternalServerError,
} from '../utils/AppError';
import { signJwt, verifyJwt } from '../utils/jwtUtils';
import { redisClient } from '../databases/redis.db';

// Cookies Configurations
const cookiesOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
};

if (envVars.NODE_ENV === 'production') cookiesOptions.secure = true;

const accessTokenCookieOptions: CookieOptions = {
  ...cookiesOptions,
  expires: new Date(Date.now() + envVars.ACCESS_TOKEN_EXPIRES * 60 * 1000),
};

const refreshTokenCookieOptions: CookieOptions = {
  ...cookiesOptions,
  expires: new Date(Date.now() + envVars.REFRESH_TOKEN_EXPIRES * 60 * 1000),
};

// Create a new User
export const createUserHandler = async (
  req: Request<{}, {}, CreateUserType>,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name, email, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 12);

    const verifyCode = crypto.randomBytes(32).toString('hex');
    const verificationCode = crypto
      .createHash('sha256')
      .update(verifyCode)
      .digest('hex');

    // Create new user
    const newUser = await createUser({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      verificationCode,
    });

    res.status(201).json({
      status: 'success',
      data: {
        user: {
          name: newUser.name,
          email: newUser.email,
        },
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      // Code'P2002' is when there are a conflict in a unique field in prisma.
      return next(new ConflictError('Email already exists'));
    }
    console.log(error);
    next(new InternalServerError('Something went wrong when signing in'));
  }
};

// Login an User
export const loginUserHandler = async (
  req: Request<{}, {}, LoginUser>,
  res: Response,
  next: NextFunction
) => {
  try {
    const { email, password } = req.body;

    // Get the user
    const user = await getUser(
      { email: email.toLowerCase() },
      { id: true, email: true, password: true }
    );

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return next(new AuthenticationError('Incorrect email or password'));
    }

    const { access_token, refresh_token } = await signTokens(user);

    res.cookie('access_token', access_token, accessTokenCookieOptions);
    res.cookie('refresh_token', refresh_token, refreshTokenCookieOptions);
    res.cookie('logged_in', true, {
      ...accessTokenCookieOptions,
      httpOnly: false,
    });
    res.status(200).json({
      status: 'success',
      access_token,
    });
  } catch (error) {
    console.log(error);
    next(new InternalServerError('Something went wrong when logging in'));
  }
};

// Route Restriction Depending on User Role
export const restrictTo =
  (...roles: UserRole[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user;

    if (!user) return next(new AuthenticationError('Session has expired'));

    if (!roles.includes(user.role)) {
      return next(
        new AuthorizationError(
          'You do not have permission to perform this action'
        )
      );
    }
    next();
  };

// Verificate Authentication
export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    let access_token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      access_token = req.headers.authorization.split(' ').at(1);
    }
    if (!access_token)
      return next(new AuthenticationError('You are not logged'));

    const decoded = verifyJwt<{ sub: string }>(
      access_token,
      'ACCESS_TOKEN_PUBLIC_KEY'
    );
    if (!decoded)
      return next(
        new AuthenticationError("Invalid token or user doesn't exist")
      );

    const session = await redisClient.get(decoded.sub);
    if (!session)
      return next(new AuthenticationError('Invalid token or session expired'));

    const user = await getUser({ id: JSON.parse(session).id });

    if (!user)
      return next(new AuthenticationError('Invalid token or session expired'));

    const localUser = {
      name: user.name,
      email: user.email,
      id: user.id,
      role: user.role,
    };
    res.locals.user = localUser;
    next();
  } catch (error) {
    console.log(error);
    next(new InternalServerError('Something went wrong when authenticating'));
  }
};

// Refreshing the token (Create and Send Access Token with)
export const refreshAccessTokenHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const errorMessage = 'Failed to refresh access token';

  try {
    const refresh_token = req.cookies.refresh_token;
    if (!refresh_token) return next(new AuthorizationError(errorMessage));

    const decoded = verifyJwt<{ sub: string }>(
      refresh_token,
      'REFRESH_TOKEN_PUBLIC_KEY'
    );
    if (!decoded) return next(new AuthorizationError(errorMessage));

    const session = await redisClient.get(decoded.sub);
    if (!session) return next(new AuthorizationError(errorMessage));

    const user = await getUser({ id: JSON.parse(session).id });
    if (!user) return next(new AuthorizationError(errorMessage));

    const access_token = signJwt({ sub: user.id }, 'ACCESS_TOKEN_PRIVATE_KEY', {
      expiresIn: `${envVars.ACCESS_TOKEN_EXPIRES}m`,
    });

    res.cookie('access_token', access_token, accessTokenCookieOptions);
    res.cookie('logged_in', true, {
      ...accessTokenCookieOptions,
      httpOnly: false,
    });

    res.status(200).json({
      status: 'success',
      access_token,
    });
  } catch (error) {
    console.log(error);
    next(
      new InternalServerError('Something went wrong when refreshing the token')
    );
  }
};

// Delete user session
export const logoutUserHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await redisClient.del(res.locals.user.id);
    res.cookie('access_token', '', { maxAge: -1 });
    res.cookie('refresh_token', '', { maxAge: -1 });
    res.cookie('logged_in', '', { maxAge: -1 });

    res.status(200).json({
      status: 'success',
    });
  } catch (error) {
    console.log(error);
    next(new InternalServerError('Something went wrong when logging out'));
  }
};
