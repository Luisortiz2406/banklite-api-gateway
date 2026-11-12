import * as http from 'http';
import { AddressInfo } from 'net';
import * as express from 'express';
import type { Request, Response } from 'express';
import { accessLog, blockInternalRoutes, proxyAll, requestId, securityHeaders } from './proxy';

/**
 * Proxy del gateway. Los servicios de atrás son servidores HTTP locales (sin red externa):
 * se prueba lo que el gateway reenvía, lo que descarta y cómo responde cuando un servicio falla.
 */
function fakeRes() {
  const headers: Record<string, unknown> = {};
  const sent: { status?: number; body?: any } = {};
  const listeners: Record<string, () => void> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
    getHeader: (name: string) => headers[name],
    on: (event: string, cb: () => void) => {
      listeners[event] = cb;
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
  return { res, headers, sent, listeners };
}

describe('middlewares del gateway', () => {
  it('requestId conserva un identificador válido del cliente y genera uno si falta o es sospechoso', () => {
    const run = (incoming?: unknown) => {
      const req = { headers: incoming === undefined ? {} : { 'x-request-id': incoming } } as unknown as Request;
      const { res, headers } = fakeRes();
      const next = jest.fn();
      requestId()(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(headers['X-Request-Id']).toBe(req.headers['x-request-id']);
      return req.headers['x-request-id'] as string;
    };

    expect(run('abc-12345678')).toBe('abc-12345678');
    expect(run()).toMatch(/^[0-9a-f-]{36}$/);
    expect(run('corto')).toMatch(/^[0-9a-f-]{36}$/);
    expect(run('con espacios y <script>')).toMatch(/^[0-9a-f-]{36}$/);
    expect(run('x'.repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('securityHeaders pone los encabezados de seguridad y evita el caché', () => {
    const { res, headers } = fakeRes();
    const next = jest.fn();

    securityHeaders()({} as Request, res, next);

    expect(headers).toMatchObject({
      'Strict-Transport-Security': expect.stringContaining('max-age=31536000'),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': expect.stringContaining("frame-ancestors 'none'"),
    });
    expect(next).toHaveBeenCalled();
  });

  it('accessLog sigue su camino y registra al terminar la respuesta', () => {
    const { res, listeners } = fakeRes();
    const next = jest.fn();
    const req = { method: 'GET', path: '/accounts', headers: { 'x-request-id': 'r1' } } as unknown as Request;

    accessLog()(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(() => listeners.finish()).not.toThrow();
  });

  describe('blockInternalRoutes', () => {
    const run = (method: string, url: string, headers: Record<string, string> = {}) => {
      const [path] = url.split('?');
      const req = { method, originalUrl: url, path, headers } as unknown as Request;
      const { res, sent } = fakeRes();
      const next = jest.fn();
      blockInternalRoutes()(req, res, next);
      return { next, sent, req };
    };

    it('una ruta interna da 404 como si no existiera', () => {
      const { next, sent } = run('POST', '/ledger/internal/rewards');
      expect(sent).toEqual({ status: 404, body: { statusCode: 404, message: 'Not Found' } });
      expect(next).not.toHaveBeenCalled();
    });

    it('una ruta ambigua (barras o puntos codificados) da 400', () => {
      expect(run('GET', '/auth/..%2finternal').sent.status).toBe(400);
      expect(run('GET', '//auth/login').sent.status).toBe(400);
    });

    it('la clave interna que mande un cliente de afuera se descarta antes de reenviar', () => {
      const { next, req } = run('GET', '/accounts?x=1', { 'x-internal-key': 'robada', authorization: 'Bearer t' });
      expect(next).toHaveBeenCalled();
      expect(req.headers['x-internal-key']).toBeUndefined();
      expect(req.headers.authorization).toBe('Bearer t');
    });
  });
});

describe('proxyAll (servicios locales de prueba)', () => {
  const servers: http.Server[] = [];
  const listen = (server: http.Server) =>
    new Promise<number>((resolve) => {
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  const get = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let body: any = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            /* texto */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it('reenvía a cada servicio por su prefijo, sin reescribir la ruta, y limpia los encabezados del servicio', async () => {
    const seen: { url?: string; headers?: http.IncomingHttpHeaders } = {};
    const accounts = await listen(
      http.createServer((req, res) => {
        seen.url = req.url;
        seen.headers = req.headers;
        res.setHeader('X-Powered-By', 'Express');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=999');
        res.setHeader('ETag', 'W/"1"');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      }),
    );
    const auth = await listen(http.createServer((_req, res) => res.end(JSON.stringify({ from: 'auth' }))));
    const app = express();
    app.disable('x-powered-by'); // igual que main.ts
    app.use(
      proxyAll([
        { name: 'auth-service', url: `http://127.0.0.1:${auth}`, prefixes: ['/auth'] },
        { name: 'account-service', url: `http://127.0.0.1:${accounts}`, prefixes: ['/accounts'] },
      ]),
    );
    app.use((_req, res) => res.status(404).json({ statusCode: 404, message: 'Not Found' }));
    const gateway = await listen(http.createServer(app));

    const reply = await get(gateway, '/accounts/123?x=1', { authorization: 'Bearer t' });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(seen.url).toBe('/accounts/123?x=1');
    expect(seen.headers?.authorization).toBe('Bearer t');
    expect(seen.headers?.['x-forwarded-for']).toBeDefined();
    expect(reply.headers['x-upstream-service']).toBe('account-service');
    for (const header of ['x-powered-by', 'access-control-allow-origin', 'cache-control', 'etag']) {
      expect(reply.headers[header]).toBeUndefined();
    }
    expect((await get(gateway, '/auth/login')).body).toEqual({ from: 'auth' });
    // un prefijo que no es de nadie sigue al siguiente middleware
    expect((await get(gateway, '/otra-cosa')).status).toBe(404);
    expect((await get(gateway, '/accountsx')).status).toBe(404);
  });

  it('si el servicio no está disponible responde 502 con un mensaje claro', async () => {
    const closed = http.createServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const app = express();
    app.use(proxyAll([{ name: 'ledger-service', url: `http://127.0.0.1:${port}`, prefixes: ['/ledger'] }]));
    const gateway = await listen(http.createServer(app));

    const reply = await get(gateway, '/ledger/accounts');

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({
      statusCode: 502,
      message: 'El servicio ledger-service no está disponible en este momento.',
    });
  });

  it('si el servicio corta la conexión a mitad de la respuesta responde 504', async () => {
    const hanging = await listen(
      http.createServer((req) => {
        req.socket.destroy();
      }),
    );
    const app = express();
    app.use(proxyAll([{ name: 'card-service', url: `http://127.0.0.1:${hanging}`, prefixes: ['/cards'] }]));
    const gateway = await listen(http.createServer(app));

    const reply = await get(gateway, '/cards');

    expect(reply.status).toBe(504);
    expect(reply.body.message).toBe('El servicio card-service tardó demasiado en responder.');
  });
});
