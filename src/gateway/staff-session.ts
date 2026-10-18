import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';

const logger = new Logger('StaffSession');

// Rutas del panel administrativo: /<servicio>/admin/...
const ADMIN_PATH = /^\/[a-z-]+\/admin(\/|$)/;
const LOGIN_PATH = '/auth/admin/login';
// Cuánto se recuerda la respuesta de auth para un token: un empleado desactivado o
// con otro rol queda fuera en, como mucho, este tiempo.
export const SESSION_CHECK_TTL_MS = 5_000;
const SESSION_CHECK_TIMEOUT_MS = 5_000;
const MAX_CACHED = 2_000;

// ok: deja pasar; si no, status y message van en la respuesta
type Verdict = { ok: boolean; status?: number; message?: string };
type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

/**
 * Cierra al instante las sesiones del panel de un empleado desactivado o con otro rol.
 * Los servicios validan el token de empleado por su cuenta (firma y rol), pero no
 * saben si auth-service lo dio de baja: antes de reenviar una petición del panel,
 * el gateway pregunta a auth-service (GET /auth/admin/session con el mismo token).
 * Si auth no responde se niega el paso (503): mejor un panel caído que uno abierto.
 */
export function staffSessionCheck(
  authUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): RequestHandler {
  const cache = new Map<string, { verdict: Verdict; until: number }>();

  async function verdictFor(authorization: string): Promise<Verdict> {
    const cached = cache.get(authorization);
    if (cached && cached.until > Date.now()) return cached.verdict;

    const res = await fetchImpl(`${authUrl}/auth/admin/session`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    let verdict: Verdict;
    if (res.ok) verdict = { ok: true };
    else if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({}));
      verdict = {
        ok: false,
        status: 401,
        message: body?.message || 'Tu sesión del panel se cerró: vuelve a ingresar.',
      };
    } else {
      // 5xx de auth: no se guarda, se vuelve a preguntar en la próxima petición
      return { ok: false, status: 503, message: 'No se pudo validar la sesión del panel. Intenta de nuevo.' };
    }

    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(authorization, { verdict, until: Date.now() + SESSION_CHECK_TTL_MS });
    return verdict;
  }

  return (req, res, next) => {
    const authorization = req.headers['authorization'];
    if (
      req.method === 'OPTIONS' ||
      !ADMIN_PATH.test(req.path) ||
      req.path === LOGIN_PATH ||
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    ) {
      return next();
    }

    verdictFor(authorization)
      .then((verdict) => {
        if (verdict.ok) return next();
        res.status(verdict.status).json({ statusCode: verdict.status, message: verdict.message });
      })
      .catch((err: Error) => {
        logger.warn(`No se pudo validar la sesión del panel con auth-service: ${err.message}`);
        res.status(503).json({ statusCode: 503, message: 'No se pudo validar la sesión del panel. Intenta de nuevo.' });
      });
  };
}
