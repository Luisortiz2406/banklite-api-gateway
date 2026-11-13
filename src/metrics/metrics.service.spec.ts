import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AppModule } from '../app.module';
import { blockInternalRoutes, proxyAll } from '../gateway/proxy';
import { loadUpstreams } from '../gateway/routes';
import { MetricsService, routeLabel } from './metrics.service';

/**
 * Métricas de Prometheus del gateway. Reglas: /metrics NUNCA sale por el puerto público (solo por
 * METRICS_PORT, red privada); las etiquetas son de lista cerrada (prefijo del servicio de destino,
 * método y código), sin ids, correos ni IPs; y un fallo de las métricas no tumba el gateway.
 */
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const EMAIL = 'ana.perez@example.com';
// Datos que no pueden aparecer en ninguna etiqueta publicada.
const SENSIBLE = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // correo
  /\b\d{1,3}(\.\d{1,3}){3}\b/, // IPv4
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // uuid
  /\b\d{9,}\b/, // números largos (documentos, cuentas, tarjetas)
];

const getText = (port: number, path: string, method = 'GET') =>
  new Promise<{ status: number; type?: string; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], text }));
    });
    req.on('error', reject);
    req.end();
  });

describe('routeLabel (gateway)', () => {
  it('una petición reenviada se agrupa por el prefijo del servicio de destino, nunca por la URL real', () => {
    expect(routeLabel({ originalUrl: `/ledger/accounts/${UUID}/balance?correo=${EMAIL}` })).toBe('/ledger/*');
    expect(routeLabel({ originalUrl: '/auth/login' })).toBe('/auth/*');
    expect(routeLabel({ originalUrl: '/deposits' })).toBe('/deposits/*');
  });

  it('la ruta propia del gateway usa su plantilla; lo que no es de nadie es "unmatched"; una regex, "regex"', () => {
    expect(routeLabel({ route: { path: '/health' }, originalUrl: '/health' })).toBe('/health');
    expect(routeLabel({ originalUrl: '/ledgerx/1' })).toBe('unmatched');
    expect(routeLabel({ originalUrl: `/no-existe/${EMAIL}` })).toBe('unmatched');
    expect(routeLabel({})).toBe('unmatched');
    expect(routeLabel({ route: { path: /^\/x$/ }, originalUrl: '/x' })).toBe('regex');
  });
});

describe('MetricsService (gateway)', () => {
  const services: MetricsService[] = [];
  const original = process.env.METRICS_PORT;
  const started = async (port: string | undefined = '0') => {
    if (port === undefined) delete process.env.METRICS_PORT;
    else process.env.METRICS_PORT = port;
    const service = new MetricsService();
    services.push(service);
    await service.onModuleInit();
    return service;
  };
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
    if (original === undefined) delete process.env.METRICS_PORT;
    else process.env.METRICS_PORT = original;
  });

  describe('registro de peticiones', () => {
    it('cuenta por ruta, método y código, y mide la duración', async () => {
      const service = await started();
      service.record({ originalUrl: '/ledger/balance', method: 'get' }, 200, 0.03);
      service.record({ originalUrl: '/ledger/balance', method: 'GET' }, 200, 0.4);
      service.record({ originalUrl: '/ledger/balance', method: 'GET' }, 502, 1.2);

      const text = await service.registry.metrics();

      expect(text).toContain('http_requests_total{route="/ledger/*",method="GET",status="200"} 2');
      expect(text).toContain('http_requests_total{route="/ledger/*",method="GET",status="502"} 1');
      expect(text).toContain('http_request_duration_seconds_count{route="/ledger/*",method="GET"} 3');
      expect(text).toMatch(/http_request_duration_seconds_bucket\{le="0\.5",route="\/ledger\/\*",method="GET"\} 2/);
    });

    it('un método raro se agrupa como OTHER', async () => {
      const service = await started();
      service.record({ method: 'BREW' }, 404, 0.001);
      expect(await service.registry.metrics()).toContain('route="unmatched",method="OTHER",status="404"');
    });

    it('el middleware registra al terminar la respuesta, con el código real', async () => {
      const service = await started();
      const listeners: Record<string, () => void> = {};
      const res = { statusCode: 429, once: (event: string, cb: () => void) => (listeners[event] = cb) };
      const next = jest.fn();

      service.middleware()({ method: 'POST', originalUrl: '/auth/login' } as never, res as never, next);
      expect(next).toHaveBeenCalled();
      listeners.finish();

      expect(await service.registry.metrics()).toContain(
        'http_requests_total{route="/auth/*",method="POST",status="429"} 1',
      );
    });
  });

  describe('servidor /metrics (puerto aparte)', () => {
    it('responde en formato Prometheus: HTTP y las de Node (CPU, memoria, event loop)', async () => {
      const service = await started();
      const reply = await getText(service.metricsPort()!, '/metrics');

      expect(reply.status).toBe(200);
      expect(reply.type).toContain('text/plain');
      expect(reply.text).toContain('# TYPE http_requests_total counter');
      expect(reply.text).toContain('# TYPE http_request_duration_seconds histogram');
      expect(reply.text).toContain('process_cpu_seconds_total');
      expect(reply.text).toContain('process_resident_memory_bytes');
      expect(reply.text).toContain('nodejs_eventloop_lag_p99_seconds');
    });

    it('solo sirve GET /metrics (con o sin parámetros); lo demás es 404', async () => {
      const port = (await started()).metricsPort()!;

      expect((await getText(port, '/metrics?x=1')).status).toBe(200);
      for (const path of ['/', '/health', '/metrics/extra']) expect((await getText(port, path)).status).toBe(404);
      expect((await getText(port, '/metrics', 'POST')).status).toBe(404);
    });

    it('si generar las métricas falla, responde 500 y el servidor sigue', async () => {
      const service = await started();
      jest.spyOn(service.registry, 'metrics').mockRejectedValueOnce(new Error('falla'));

      expect((await getText(service.metricsPort()!, '/metrics')).status).toBe(500);
      expect((await getText(service.metricsPort()!, '/metrics')).status).toBe(200);
    });

    it('METRICS_PORT=off lo apaga; un valor inválido no lo inicia ni rompe el arranque', async () => {
      expect((await started('off')).metricsPort()).toBeNull();
      for (const invalido of ['abc', '-1', '70000', '9100.5']) {
        expect((await started(invalido)).metricsPort()).toBeNull();
      }
    });

    it('si el puerto está ocupado el gateway arranca igual, sin métricas', async () => {
      const primero = await started();

      const segundo = await started(String(primero.metricsPort()));

      expect(segundo.metricsPort()).toBeNull();
      expect((await getText(primero.metricsPort()!, '/metrics')).status).toBe(200);
    });

    it('al cerrar el módulo deja de escuchar', async () => {
      const service = await started();
      const port = service.metricsPort()!;

      await service.onModuleDestroy();

      expect(service.metricsPort()).toBeNull();
      await expect(getText(port, '/metrics')).rejects.toThrow();
    });
  });

  describe('con el gateway real: /metrics no sale por el puerto público', () => {
    let app: INestApplication;
    let metrics: MetricsService;
    let upstream: http.Server;
    let publicPort: number;
    const seen: string[] = [];
    const envBefore = { ...process.env };

    beforeAll(async () => {
      upstream = http.createServer((req, res) => {
        seen.push(req.url ?? '');
        res.setHeader('Content-Type', 'application/json').end('{"ok":true}');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      process.env.LEDGER_SERVICE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      process.env.METRICS_PORT = '0';

      app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
      metrics = app.get(MetricsService);
      // Mismo orden que main.ts: métricas, bloqueo de rutas internas y proxy.
      app.use(metrics.middleware());
      app.use(blockInternalRoutes());
      app.use(proxyAll(loadUpstreams()));
      await app.listen(0, '127.0.0.1');
      publicPort = Number(new URL(await app.getUrl()).port);
    });
    afterAll(async () => {
      await app.close();
      await new Promise((resolve) => upstream.close(resolve));
      process.env = envBefore;
    });

    it('por el puerto público /metrics da 404 en todas sus variantes y no entrega ninguna métrica', async () => {
      for (const path of ['/metrics', '/metrics/', '/METRICS', '/Metrics?x=1', '/metrics/otra', '/%6Detrics']) {
        const reply = await getText(publicPort, path);
        expect(reply.status).toBe(404);
        expect(reply.text).not.toContain('http_requests_total');
        expect(reply.text).not.toContain('process_cpu_seconds_total');
      }
      for (const path of ['//metrics', '/x/..%2fmetrics', '/%2e%2e/metrics']) {
        const reply = await getText(publicPort, path);
        expect([400, 404]).toContain(reply.status);
        expect(reply.text).not.toContain('http_requests_total');
      }
      // Nada de eso llegó a un servicio de atrás
      expect(seen).toEqual([]);
    });

    it('con otro método tampoco sale por el puerto público', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const reply = await getText(publicPort, '/metrics', method);
        expect(reply.text).not.toContain('http_requests_total');
      }
    });

    it('las métricas sí salen por su puerto aparte (red privada)', async () => {
      const reply = await getText(metrics.metricsPort()!, '/metrics');

      expect(reply.status).toBe(200);
      expect(reply.text).toContain('# TYPE http_requests_total counter');
      expect(metrics.metricsPort()).not.toBe(publicPort);
    });

    it('lo reenviado se cuenta por el prefijo del servicio y las etiquetas no llevan datos del cliente', async () => {
      await getText(publicPort, `/ledger/accounts/${UUID}/balance?correo=${EMAIL}`);
      await getText(publicPort, `/no-existe/${EMAIL}/${UUID}`);
      await getText(publicPort, '/ledger/internal/rewards', 'POST');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const text = await metrics.registry.metrics();

      expect(seen).toEqual([`/ledger/accounts/${UUID}/balance?correo=${EMAIL}`]);
      expect(text).toContain('http_requests_total{route="/ledger/*",method="GET",status="200"} 1');
      expect(text).toContain('http_requests_total{route="/ledger/*",method="POST",status="404"} 1');
      expect(text).toContain('route="unmatched",method="GET",status="404"');
      // Se revisan las ETIQUETAS publicadas (lo que va entre llaves); los valores son mediciones.
      const etiquetas = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(' | ');
      for (const patron of SENSIBLE) expect(etiquetas).not.toMatch(patron);
    });

    it('las únicas etiquetas propias son route, method y status', async () => {
      const text = await metrics.registry.metrics();
      const propias = text.split('\n').filter((l) => l.startsWith('http_'));
      const etiquetas = new Set(propias.flatMap((l) => [...l.matchAll(/([a-z_]+)="/g)].map((m) => m[1])));

      expect([...etiquetas].sort()).toEqual(['le', 'method', 'route', 'status']);
    });
  });
});
