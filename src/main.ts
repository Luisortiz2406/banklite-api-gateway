import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import {
  accessLog,
  blockInternalRoutes,
  proxyAll,
  requestId,
  securityHeaders,
  webhookBodyLimit,
} from './gateway/proxy';
import { clientIp, clientIpDiagnostics } from './gateway/client-ip';
import { consentGate } from './gateway/consent-gate';
import { rateLimit } from './gateway/rate-limit';
import { loadUpstreams } from './gateway/routes';
import { staffSessionCheck } from './gateway/staff-session';

async function bootstrap() {
  // Sin bodyParser: el cuerpo de la petición se reenvía intacto al microservicio.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.enableCors({
    origin: corsOrigins(),
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  const upstreams = loadUpstreams();
  app.use(securityHeaders());
  app.use(requestId());
  app.use(accessLog());
  app.use(clientIp());
  app.use(rateLimit());
  app.use(clientIpDiagnostics());
  app.use(blockInternalRoutes());
  app.use(webhookBodyLimit());
  // Clientes sin la autorización de datos vigente: 403 (los empleados no se ven afectados).
  app.use(consentGate());
  // Sesiones del panel administrativo: auth-service decide si siguen vigentes
  const auth = upstreams.find((s) => s.name === 'auth-service');
  if (auth) app.use(staffSessionCheck(auth.url));
  app.use(proxyAll(upstreams));

  const port = process.env.PORT ?? 8080;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`API Gateway escuchando en http://localhost:${port}`);
  for (const s of upstreams) logger.log(`${s.prefixes.join(', ')} -> ${s.name} (${s.url})`);
}

/**
 * CORS_ORIGINS: lista separada por comas de orígenes exactos (p. ej. el dominio
 * del frontend en Railway). En producción es obligatoria y no admite '*': el
 * gateway no arranca sin ella. Fuera de producción, si falta, solo se aceptan
 * orígenes de localhost / 127.0.0.1 (cualquier puerto).
 */
function corsOrigins(): string[] | RegExp {
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.includes('*')) throw new Error("CORS_ORIGINS no puede ser '*': lista los dominios del frontend.");
  if (origins.length) return origins;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CORS_ORIGINS es obligatoria en producción (dominio(s) del frontend, separados por comas).');
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
}

bootstrap();
