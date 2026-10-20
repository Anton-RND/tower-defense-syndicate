import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

import { AppError, ErrorCodes } from '../../lib/errors.js';

/**
 * Лёгкий JWT (HS256) без внешних зависимостей: достаточно для сессий SPA в WebView.
 * Клиент получает токен один раз после проверки initData и дальше ходит с ним
 * (`Authorization: Bearer <token>`), повторно дёргать VK не нужно.
 */
export interface SessionClaims {
  /** Внутренний id пользователя. */
  sub: string;
  platform: 'vk' | 'tg';
  /** Социальный id — удобно для диагностики без похода в БД. */
  sid: string;
  iat: number;
  exp: number;
  jti: string;
}

export type SessionSubject = Pick<SessionClaims, 'sub' | 'platform' | 'sid'>;

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function unb64u(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function safeStringEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface TokenServiceOptions {
  secret: string;
  ttlSec: number;
}

export class TokenService {
  constructor(private readonly options: TokenServiceOptions) {
    if (options.secret.length < 16) {
      throw new Error('TokenService: секрет токена слишком короткий (минимум 16 символов)');
    }
  }

  /** Выпускает сессионный токен. */
  issue(subject: SessionSubject, now: Date = new Date()): { token: string; expiresAt: Date; claims: SessionClaims } {
    const iat = Math.floor(now.getTime() / 1000);
    const claims: SessionClaims = { ...subject, iat, exp: iat + this.options.ttlSec, jti: randomUUID() };
    const unsigned = `${b64u(JSON.stringify(HEADER))}.${b64u(JSON.stringify(claims))}`;
    return {
      token: `${unsigned}.${this.signature(unsigned)}`,
      expiresAt: new Date(claims.exp * 1000),
      claims
    };
  }

  /** Проверяет подпись, алгоритм и срок жизни. Бросает AppError(401, INVALID_TOKEN). */
  verify(token: string, now: Date = new Date()): SessionClaims {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'Формат токена некорректен');
    }
    const [header, payload, signature] = parts as [string, string, string];

    let parsedHeader: { alg?: unknown; typ?: unknown };
    try {
      parsedHeader = JSON.parse(unb64u(header).toString('utf8')) as typeof parsedHeader;
    } catch {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'Не удалось декодировать заголовок токена');
    }
    // Явно отсекаем alg=none и посторонние алгоритмы (классическая атака на самописные JWT).
    if (parsedHeader.alg !== HEADER.alg || parsedHeader.typ !== HEADER.typ) {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'Неподдерживаемый алгоритм токена');
    }

    if (!safeStringEquals(this.signature(`${header}.${payload}`), signature)) {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'Подпись токена не прошла проверку');
    }

    let claims: SessionClaims;
    try {
      claims = JSON.parse(unb64u(payload).toString('utf8')) as SessionClaims;
    } catch {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'Не удалось декодировать полезную нагрузку токена');
    }

    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'В токене нет sub');
    }
    if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(now.getTime() / 1000)) {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 401, 'Срок действия токена истёк');
    }
    return claims;
  }

  private signature(unsigned: string): string {
    return createHmac('sha256', this.options.secret).update(unsigned, 'utf8').digest('base64url');
  }
}

/** Достаёт Bearer-токен из заголовка Authorization. */
export function extractBearer(headerValue: string | string[] | undefined): string | null {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

