import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';

const logger = new Logger('ConsentGate');

// Lo que un cliente sin la autorización vigente sí puede hacer: aceptarla (o ver
// su estado), renovar el token, iniciar sesión y registrarse.
const ALLOWED = [
  /^\/auth\/consentimientos(\/estado)?\/?$/i,
  /^\/auth\/refresh-token\/?$/i,
  /^\/auth\/login\/?$/i,
  /^\/auth\/register\/?$/i,
  /^\/health(\/|$)/i,
];

const MIN_SECRET_LENGTH = 32;

type Payload = { sub?: string; type?: string; cons?: boolean; exp?: number; nbf?: number };

const b64json = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Lee el payload SIN verificar (solo para saber si es de empleado). null si no es un JWT. */
function peek(token: string): Payload | null {
  try {
    return b64json(token.split('.')[1] ?? '');
  } catch {
    return null;
  }
}

/** Verifica un JWT HS256 (firma, alg, exp, nbf). null si no es válido. */
export function verifyHs256(token: string, secret: string, now = Date.now()): Payload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64json(parts[0]);
    if (header?.alg !== 'HS256') return null; // nada de "none" ni otros algoritmos
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const received = Buffer.from(parts[2], 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const payload: Payload = b64json(parts[1]);
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Autorización de datos: un CLIENTE solo opera si su token de acceso trae la
 * marca cons (aceptó la versión vigente de la política y los términos; la pone
 * auth-service). El gateway VERIFICA la firma con el JWT_SECRET compartido antes
 * de mirar la marca:
 *   - firma inválida, alg distinto o vencido → 401 (el frontend renueva el token);
 *   - token de cliente sin cons → 403 { code: 'CONSENTIMIENTO_REQUERIDO' } (el frontend
 *     muestra el modal);
 *   - tokens de EMPLEADO (type staff, firmados con otro secreto) pasan sin cambios: el
 *     panel /admin no se ve afectado (cada servicio y staffSessionCheck los validan);
 *   - sin token, o en las rutas permitidas, pasa: el servicio decide.
 * Si alguien pone type 'staff' en un token de cliente para saltarse el filtro, el
 * servicio lo rechaza igual: la firma no coincide con ninguno de los dos secretos.
 */
export function consentGate(secret = process.env.JWT_SECRET): RequestHandler {
  // Un secreto con espacios o comillas alrededor (p. ej. al pegarlo en Railway) no
  // coincide con el de auth-service: todos los clientes recibirían 401. Mejor no
  // arrancar con un mensaje claro (Railway sigue sirviendo el despliegue anterior).
  // Nunca se muestra el valor.
  if (secret && (secret !== secret.trim() || /^["']|["']$/.test(secret))) {
    throw new Error(
      'JWT_SECRET tiene espacios o comillas al inicio o al final: escríbela sin ellos (en Railway, exactamente ${{shared.JWT_SECRET}}).',
    );
  }
  const enabled = !!secret && secret.length >= MIN_SECRET_LENGTH;
  if (!enabled) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'JWT_SECRET es obligatoria en producción (32+ caracteres): el gateway exige la autorización de datos.',
      );
    }
    logger.warn('Sin JWT_SECRET: no se exige la autorización de datos (solo fuera de producción).');
  }

  return (req, res, next) => {
    if (!enabled || req.method === 'OPTIONS') return next();
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return next();
    if (ALLOWED.some((route) => route.test(req.path))) return next();

    const token = authorization.slice('Bearer '.length).trim();
    if (peek(token)?.type === 'staff') return next();

    const payload = verifyHs256(token, secret!);
    if (!payload) {
      return res.status(401).json({ statusCode: 401, message: 'Token inválido o expirado' });
    }
    if (payload.type === 'access' && payload.cons !== true) {
      return res.status(403).json({
        statusCode: 403,
        code: 'CONSENTIMIENTO_REQUERIDO',
        message: 'Para continuar debes aceptar la política de privacidad.',
      });
    }
    next();
  };
}
