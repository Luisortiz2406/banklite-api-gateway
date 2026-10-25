import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { webhookBodyLimit } from './proxy';
import { rateLimit } from './rate-limit';
import { isInternalRoute, isWebhookRoute, loadUpstreams } from './routes';

function run(middleware: RequestHandler, path: string, headers: Record<string, string> = {}, method = 'POST') {
  const req = { method, path, headers, ip: '203.0.113.7' } as unknown as Request;
  const sent: { status?: number; body?: any } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
    setHeader: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  middleware(req, res, next);
  return { next, sent };
}

const WEBHOOK = '/deposits/wompi/events';

describe('Gateway: webhook de Wompi', () => {
  it('es una ruta pública de deposit-service (no interna)', () => {
    expect(isWebhookRoute('POST', WEBHOOK)).toBe(true);
    expect(isWebhookRoute('GET', WEBHOOK)).toBe(false);
    expect(isWebhookRoute('POST', '/deposits')).toBe(false);
    expect(isInternalRoute('POST', WEBHOOK)).toBe(false);
    expect(loadUpstreams().find((s) => s.name === 'deposit-service')?.prefixes).toEqual(['/deposits']);
  });

  it('limita el tamaño del cuerpo: 413 si es mayor de 64 KB y 411 sin Content-Length', () => {
    const limit = webhookBodyLimit();

    const ok = run(limit, WEBHOOK, { 'content-length': '2048' });
    expect(ok.next).toHaveBeenCalled();

    const big = run(limit, WEBHOOK, { 'content-length': String(64 * 1024 + 1) });
    expect(big.next).not.toHaveBeenCalled();
    expect(big.sent.status).toBe(413);

    const chunked = run(limit, WEBHOOK, { 'transfer-encoding': 'chunked' });
    expect(chunked.next).not.toHaveBeenCalled();
    expect(chunked.sent.status).toBe(411);
  });

  it('no afecta las demás rutas', () => {
    const { next } = run(webhookBodyLimit(), '/deposits', { 'transfer-encoding': 'chunked' });
    expect(next).toHaveBeenCalled();
  });

  it('limita las peticiones por minuto por IP (60 por defecto)', () => {
    const limiter = rateLimit();
    for (let i = 0; i < 60; i++) expect(run(limiter, WEBHOOK).next).toHaveBeenCalled();

    const blocked = run(limiter, WEBHOOK);
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.sent.status).toBe(429);

    // El límite del webhook no consume el de las demás rutas.
    expect(run(limiter, '/deposits', {}, 'GET').next).toHaveBeenCalled();
  });
});
