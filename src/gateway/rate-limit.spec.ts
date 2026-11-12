import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from './rate-limit';

/**
 * Límite de peticiones por IP (ventana fija de 1 minuto). Las rutas que disparan correos o prueban
 * credenciales tienen un tope más bajo que el global; OPTIONS (CORS) no cuenta.
 */
function call(limiter: ReturnType<typeof rateLimit>, path: string, ip = '203.0.113.7', method = 'POST') {
  const req = { method, path, ip, clientIp: ip } as unknown as Request;
  const sent: { status?: number; body?: any; headers: Record<string, unknown> } = { headers: {} };
  const res = {
    setHeader: (name: string, value: unknown) => {
      sent.headers[name] = value;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  limiter(req, res, next);
  return { next, sent };
}

describe('rateLimit', () => {
  afterEach(() => jest.useRealTimers());

  it('login y registro: 20 por minuto; el 21 recibe 429 con Retry-After', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 20; i++) expect(call(limiter, '/auth/login').next).toHaveBeenCalled();

    const blocked = call(limiter, '/auth/login');

    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.sent.status).toBe(429);
    expect(blocked.sent.body.message).toContain('Demasiadas solicitudes');
    expect(Number(blocked.sent.headers['Retry-After'])).toBeGreaterThan(0);
    expect(Number(blocked.sent.headers['Retry-After'])).toBeLessThanOrEqual(60);
  });

  it('la verificación de códigos tiene su propio tope de 10 por minuto (frena la fuerza bruta repartida)', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 10; i++) expect(call(limiter, '/auth/email/verify').next).toHaveBeenCalled();

    expect(call(limiter, '/auth/email/verify').sent.status).toBe(429);
    // y los demás endpoints de esa IP siguen disponibles
    expect(call(limiter, '/accounts').next).toHaveBeenCalled();
  });

  it('cada IP cuenta aparte', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 21; i++) call(limiter, '/auth/login', '198.51.100.1');

    expect(call(limiter, '/auth/login', '198.51.100.1').sent.status).toBe(429);
    expect(call(limiter, '/auth/login', '198.51.100.2').next).toHaveBeenCalled();
  });

  it('el webhook de Wompi: 60 por minuto', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 60; i++) expect(call(limiter, '/deposits/wompi/events').next).toHaveBeenCalled();

    expect(call(limiter, '/deposits/wompi/events').sent.status).toBe(429);
  });

  it('el tope global es de 300 por minuto para cualquier ruta', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 300; i++) expect(call(limiter, '/accounts', undefined, 'GET').next).toHaveBeenCalled();

    expect(call(limiter, '/accounts', undefined, 'GET').sent.status).toBe(429);
  });

  it('OPTIONS (CORS) no cuenta', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 400; i++) expect(call(limiter, '/auth/login', undefined, 'OPTIONS').next).toHaveBeenCalled();

    expect(call(limiter, '/auth/login').next).toHaveBeenCalled();
  });

  it('pasado el minuto la ventana se reinicia', () => {
    jest.useFakeTimers();
    const limiter = rateLimit();
    for (let i = 0; i < 21; i++) call(limiter, '/auth/login');
    expect(call(limiter, '/auth/login').sent.status).toBe(429);

    jest.advanceTimersByTime(61_000);

    expect(call(limiter, '/auth/login').next).toHaveBeenCalled();
  });

  it('sin la IP resuelta por el gateway usa req.ip', () => {
    const limiter = rateLimit();
    const req = { method: 'GET', path: '/accounts', ip: '192.0.2.9' } as unknown as Request;
    const next = jest.fn();
    limiter(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
  });
});
