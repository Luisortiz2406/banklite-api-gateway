import { Controller, Get } from '@nestjs/common';
import { loadUpstreams } from './gateway/routes';

// Un servicio que no responde /health en este tiempo se muestra como caído.
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

@Controller()
export class HealthController {
  private readonly upstreams = loadUpstreams();

  @Get('health')
  async check() {
    const services = await Promise.all(
      this.upstreams.map(async (s) => {
        const start = Date.now();
        try {
          const res = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
          // Con la base caída el servicio responde 503 y su cuerpo dice "database": "down".
          const body = (await res.json().catch(() => ({}))) as { status?: string; database?: string };
          const database = body.database === 'ok' ? 'ok' : body.database === 'down' ? 'down' : 'unknown';
          const status = res.ok && body.status === 'ok' && database === 'ok' ? 'ok' : 'down';
          return { name: s.name, status, database, latencyMs: Date.now() - start };
        } catch {
          // El servicio no respondió: no se sabe nada de su base.
          return { name: s.name, status: 'down', database: 'unknown', latencyMs: Date.now() - start };
        }
      }),
    );
    // Siempre 200: el gateway sigue sano aunque un servicio de atrás no lo esté.
    return {
      status: services.every((s) => s.status === 'ok') ? 'ok' : 'degraded',
      service: 'api-gateway',
      services,
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  info() {
    return {
      service: 'api-gateway',
      routes: Object.fromEntries(this.upstreams.map((s) => [s.name, s.prefixes])),
    };
  }
}

// DEMO (no mergear): variable sin usar para que falle el lint del pipeline.
const variableSinUsar = 'falla a propósito';
