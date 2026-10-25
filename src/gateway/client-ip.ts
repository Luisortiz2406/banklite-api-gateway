import { isIP } from 'net';
import type { Request, RequestHandler } from 'express';

/** Encabezado con el que el gateway le pasa la IP del cliente a los servicios internos. */
export const FORWARDED_CLIENT_IP_HEADER = 'x-client-ip';

export interface ResolvedClientIp {
  ip: string | null;
  // De dónde salió: el encabezado del proxy de Railway (variable CLIENT_IP_HEADER) o la conexión directa.
  source: 'header' | 'socket' | 'none';
}

/** Quita el prefijo IPv4-mapeado (::ffff:1.2.3.4) y valida que sea una IP. */
function normalize(value: string | undefined | null): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

/**
 * IP real del cliente. En Railway el proxy de entrada la manda en un encabezado
 * (variable CLIENT_IP_HEADER, p. ej. x-real-ip); sin esa variable (local) se usa la
 * conexión directa. Un encabezado con una IP inválida no se usa.
 */
export function resolveClientIp(req: Request, sourceHeader = process.env.CLIENT_IP_HEADER): ResolvedClientIp {
  const header = sourceHeader?.trim().toLowerCase();
  if (header) {
    const raw = req.headers[header];
    // Si llega como lista (a, b), el primero es el cliente.
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0];
    const ip = normalize(first);
    if (ip) return { ip, source: 'header' };
  }
  const socketIp = normalize(req.socket?.remoteAddress);
  return socketIp ? { ip: socketIp, source: 'socket' } : { ip: null, source: 'none' };
}

/** Expande una IPv6 a sus 8 grupos de 4 dígitos. */
function expandIpv6(ip: string): string[] {
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((g) => g.padStart(4, '0'));
}

/** Prefijo de red sin la parte del equipo: /24 en IPv4 y /48 en IPv6. */
export function ipPrefix(ip: string): string {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  return `${expandIpv6(ip).slice(0, 3).join(':')}::/48`;
}

/**
 * Resuelve la IP del cliente una sola vez por petición: la deja en req.clientIp
 * (límite de peticiones) y en el encabezado x-client-ip para los servicios. Un
 * x-client-ip que mande el cliente siempre se descarta. Nunca se registra.
 */
export function clientIp(): RequestHandler {
  return (req, _res, next) => {
    delete req.headers[FORWARDED_CLIENT_IP_HEADER];
    const { ip } = resolveClientIp(req);
    (req as Request & { clientIp?: string | null }).clientIp = ip;
    if (ip) req.headers[FORWARDED_CLIENT_IP_HEADER] = ip;
    next();
  };
}

/**
 * GET /health/client-ip (solo con CLIENT_IP_DEBUG=true): para comprobar en
 * producción que el gateway ve la IP real. Le responde a quien llama solo con
 * SU prefijo (/24 o /48) y de dónde salió; no se escribe en los logs.
 */
export function clientIpDiagnostics(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/health/client-ip' || process.env.CLIENT_IP_DEBUG !== 'true') {
      return next();
    }
    const resolved = resolveClientIp(req);
    const realIp = normalize(req.headers['x-real-ip'] as string | undefined);
    const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
    const forwardedIps = forwarded
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const socketIp = normalize(req.socket?.remoteAddress);
    res.json({
      fuente: resolved.source === 'header' ? process.env.CLIENT_IP_HEADER : resolved.source,
      prefijo: resolved.ip ? ipPrefix(resolved.ip) : null,
      xRealIp: { presente: !!realIp, coincide: !!realIp && realIp === resolved.ip },
      xForwardedFor: {
        presente: forwardedIps.length > 0,
        saltos: forwardedIps.length,
        primeraCoincide: forwardedIps.length > 0 && normalize(forwardedIps[0]) === resolved.ip,
      },
      conexionDirectaCoincide: socketIp === resolved.ip,
      reqIpCoincide: normalize(req.ip) === resolved.ip,
    });
  };
}
