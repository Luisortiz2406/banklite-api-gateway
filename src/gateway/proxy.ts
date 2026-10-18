import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { isAmbiguousPath, isInternalRoute, matchesPrefix, UpstreamService } from './routes';

const logger = new Logger('Gateway');
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 15_000);

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

/** Encabezados de seguridad para todas las respuestas de la API (que además nunca se cachean). */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  };
}

export function accessLog(): RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const upstream = res.getHeader('X-Upstream-Service') ?? '-';
      logger.log(
        `${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms -> ${upstream} [${req.headers['x-request-id']}]`,
      );
    });
    next();
  };
}

export function blockInternalRoutes(): RequestHandler {
  return (req, res, next) => {
    const rawPath = req.originalUrl.split('?')[0];
    if (isAmbiguousPath(rawPath)) {
      return res.status(400).json({ statusCode: 400, message: 'Ruta no válida' });
    }
    if (isInternalRoute(req.method, req.path)) {
      return res.status(404).json({ statusCode: 404, message: 'Not Found' });
    }
    // La clave interna nunca viene de afuera: no se reenvía aunque la manden.
    delete req.headers['x-internal-key'];
    next();
  };
}

export function proxyTo(service: UpstreamService): RequestHandler {
  return createProxyMiddleware<Request, Response>({
    target: service.url,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    pathFilter: (pathname) => service.prefixes.some((p) => matchesPrefix(pathname, p)),
    on: {
      proxyReq: (_proxyReq, _req, res) => {
        res.setHeader('X-Upstream-Service', service.name);
      },
      proxyRes: (proxyRes) => {
        // El gateway es quien decide CORS; se descartan los encabezados del servicio.
        // Tampoco se expone la tecnología de los servicios ni su política de caché.
        for (const header of Object.keys(proxyRes.headers)) {
          if (
            header.startsWith('access-control-') ||
            header === 'x-powered-by' ||
            header === 'cache-control' ||
            header === 'etag'
          ) {
            delete proxyRes.headers[header];
          }
        }
      },
      error: (err, req, res) => {
        const timedOut = (err as NodeJS.ErrnoException).code === 'ECONNRESET' || /timeout/i.test(err.message);
        logger.warn(`${service.name} falló para ${req.method} ${req.url}: ${err.message}`);
        if (!('writeHead' in res) || res.headersSent) return;
        const status = timedOut ? 504 : 502;
        (res as Response).status(status).json({
          statusCode: status,
          message: timedOut
            ? `El servicio ${service.name} tardó demasiado en responder.`
            : `El servicio ${service.name} no está disponible en este momento.`,
        });
      },
    },
  });
}

export function proxyAll(services: UpstreamService[]): RequestHandler {
  const handlers = services.map(proxyTo);
  return (req: Request, res: Response, next: NextFunction) => {
    let i = 0;
    const run = () => (i < handlers.length ? handlers[i++](req, res, run) : next());
    run();
  };
}
