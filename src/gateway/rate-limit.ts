import type { NextFunction, Request, Response } from 'express';

interface Window {
  count: number;
  resetAt: number;
}

interface Rule {
  name: string;
  max: number;
  windowMs: number;
  applies: (req: Request) => boolean;
}

// Rutas que disparan correos/WhatsApp o prueban credenciales (clientes y empleados): límite más bajo.
const SENSITIVE = /^\/auth\/(login|register|password-recovery\/send|email\/send|whatsapp\/send|admin\/login)\/?$/;

const RULES: Rule[] = [
  { name: 'sensitive', max: Number(process.env.RATE_LIMIT_SENSITIVE_PER_MIN ?? 20), windowMs: 60_000, applies: (req) => SENSITIVE.test(req.path) },
  { name: 'global', max: Number(process.env.RATE_LIMIT_PER_MIN ?? 300), windowMs: 60_000, applies: () => true },
];

// Límite por IP en memoria (ventana fija). Suficiente con una sola instancia del
// gateway; con varias réplicas habría que moverlo a Redis.
export function rateLimit() {
  const windows = new Map<string, Window>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();
    const now = Date.now();
    for (const rule of RULES) {
      if (!rule.applies(req)) continue;
      const key = `${rule.name}:${req.ip}`;
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + rule.windowMs };
        windows.set(key, w);
      }
      w.count++;
      if (w.count > rule.max) {
        res.setHeader('Retry-After', Math.ceil((w.resetAt - now) / 1000));
        return res.status(429).json({ statusCode: 429, message: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
      }
    }
    next();
  };
}
