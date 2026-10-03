import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { accessLog, blockInternalRoutes, proxyAll, requestId } from './gateway/proxy';
import { rateLimit } from './gateway/rate-limit';
import { loadUpstreams } from './gateway/routes';

async function bootstrap() {
  // Sin bodyParser: el cuerpo de la petición se reenvía intacto al microservicio.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.set('trust proxy', 1);

  // CORS_ORIGINS: lista separada por comas; vacío o '*' permite cualquier origen.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: origins.length === 0 || origins.includes('*') ? true : origins,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  const upstreams = loadUpstreams();
  app.use(requestId());
  app.use(accessLog());
  app.use(rateLimit());
  app.use(blockInternalRoutes());
  app.use(proxyAll(upstreams));

  const port = process.env.PORT ?? 8080;
  await app.listen(port);
  console.log(`API Gateway escuchando en http://localhost:${port}`);
  for (const s of upstreams) console.log(`  ${s.prefixes.join(', ')} -> ${s.name} (${s.url})`);
}

bootstrap();
