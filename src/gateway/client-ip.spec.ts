import type { NextFunction, Request, Response } from 'express';
import { clientIp, clientIpDiagnostics, ipPrefix, resolveClientIp } from './client-ip';
import { rateLimit } from './rate-limit';

function request(headers: Record<string, string> = {}, remoteAddress = '10.0.0.5', path = '/accounts') {
  return {
    method: 'GET',
    path,
    headers: { ...headers },
    ip: remoteAddress,
    socket: { remoteAddress },
  } as unknown as Request;
}

function response() {
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
  return { res, sent };
}

describe('Gateway: IP real del cliente', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('con CLIENT_IP_HEADER=x-real-ip usa el encabezado del proxy de Railway', () => {
    const req = request({ 'x-real-ip': '181.52.33.10' });
    expect(resolveClientIp(req, 'x-real-ip')).toEqual({ ip: '181.52.33.10', source: 'header' });
  });

  it('sin CLIENT_IP_HEADER (local) usa la conexión directa y quita el prefijo ::ffff:', () => {
    const req = request({ 'x-real-ip': '181.52.33.10' }, '::ffff:172.18.0.4');
    expect(resolveClientIp(req, '')).toEqual({ ip: '172.18.0.4', source: 'socket' });
  });

  it('un encabezado con una IP inválida no se usa', () => {
    const req = request({ 'x-real-ip': 'no-es-una-ip' });
    expect(resolveClientIp(req, 'x-real-ip')).toEqual({ ip: '10.0.0.5', source: 'socket' });
  });

  it('si el encabezado trae una lista, toma el primero (el cliente)', () => {
    const req = request({ 'x-forwarded-for': '190.24.1.2, 10.1.1.1' });
    expect(resolveClientIp(req, 'x-forwarded-for').ip).toBe('190.24.1.2');
  });

  it('descarta el x-client-ip que manda el cliente y pone el resuelto', () => {
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    const req = request({ 'x-real-ip': '181.52.33.10', 'x-client-ip': '1.2.3.4' });
    const next = jest.fn() as NextFunction;
    clientIp()(req, response().res, next);
    expect(req.headers['x-client-ip']).toBe('181.52.33.10');
    expect((req as any).clientIp).toBe('181.52.33.10');
    expect(next).toHaveBeenCalled();
  });

  it('recorta la IP a su red: /24 en IPv4 y /48 en IPv6', () => {
    expect(ipPrefix('181.52.33.10')).toBe('181.52.33.0/24');
    expect(ipPrefix('2800:e2:4a80:1234::7')).toBe('2800:00e2:4a80::/48');
    expect(ipPrefix('::1')).toBe('0000:0000:0000::/48');
  });

  describe('diagnóstico GET /health/client-ip', () => {
    it('está apagado por defecto (sigue al siguiente middleware → 404)', () => {
      const next = jest.fn() as NextFunction;
      const { res, sent } = response();
      clientIpDiagnostics()(request({}, '10.0.0.5', '/health/client-ip'), res, next);
      expect(next).toHaveBeenCalled();
      expect(sent.body).toBeUndefined();
    });

    it('con CLIENT_IP_DEBUG=true responde solo el prefijo, nunca la IP completa', () => {
      process.env.CLIENT_IP_DEBUG = 'true';
      process.env.CLIENT_IP_HEADER = 'x-real-ip';
      const req = request(
        { 'x-real-ip': '181.52.33.10', 'x-forwarded-for': '181.52.33.10' },
        '100.64.0.2',
        '/health/client-ip',
      );
      const { res, sent } = response();
      clientIpDiagnostics()(req, res, jest.fn());
      expect(sent.body).toMatchObject({
        fuente: 'x-real-ip',
        prefijo: '181.52.33.0/24',
        xRealIp: { presente: true, coincide: true },
        xForwardedFor: { presente: true, saltos: 1, primeraCoincide: true },
        conexionDirectaCoincide: false,
      });
      expect(JSON.stringify(sent.body)).not.toContain('181.52.33.10');
    });
  });

  it('el límite de peticiones cuenta por la IP del cliente, no por la del proxy', () => {
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    const limiter = rateLimit();
    const pass = (ip: string) => {
      const req = request({ 'x-real-ip': ip }, '100.64.0.2', '/auth/login');
      (req as any).method = 'POST';
      clientIp()(req, response().res, jest.fn());
      const next = jest.fn() as NextFunction;
      const { res, sent } = response();
      limiter(req, res, next);
      return { allowed: (next as jest.Mock).mock.calls.length === 1, status: sent.status };
    };
    // Mismo proxy, dos clientes: el límite de rutas sensibles (20/min) es por cliente.
    for (let i = 0; i < 20; i++) expect(pass('181.52.33.10').allowed).toBe(true);
    expect(pass('181.52.33.10').status).toBe(429);
    expect(pass('190.24.1.2').allowed).toBe(true);
  });
});
