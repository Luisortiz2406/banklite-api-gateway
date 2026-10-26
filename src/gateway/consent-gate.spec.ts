import { createHmac } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { consentGate, verifyHs256 } from './consent-gate';

const SECRET = 'secreto-de-clientes-de-prueba-0123456789abcdef';
const STAFF_SECRET = 'secreto-de-empleados-de-prueba-0123456789abcdef';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload: object, secret = SECRET, header: object = { alg: 'HS256', typ: 'JWT' }) {
  const unsigned = `${b64(header)}.${b64(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const client = (extra: object = {}) => ({ sub: 'cliente-1', type: 'access', iat: now, exp: now + 900, ...extra });

function run(path: string, token?: string, method = 'GET') {
  const req = { method, path, headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as Request;
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
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  consentGate(SECRET)(req, res, next);
  return { passed: (next as jest.Mock).mock.calls.length === 1, sent };
}

describe('Gateway: autorización de datos (marca cons)', () => {
  it('cliente con cons y firma válida: pasa', () => {
    expect(run('/transfers/prepare', sign(client({ cons: true })), 'POST').passed).toBe(true);
  });

  it('cliente sin cons: 403 CONSENTIMIENTO_REQUERIDO', () => {
    const { passed, sent } = run('/ledger/accounts/abc/balance', sign(client()));
    expect(passed).toBe(false);
    expect(sent).toEqual({
      status: 403,
      body: expect.objectContaining({ statusCode: 403, code: 'CONSENTIMIENTO_REQUERIDO' }),
    });
  });

  it('firma inválida (otro secreto o token alterado): 401', () => {
    const forged = sign(client({ cons: true }), 'otro-secreto-que-no-es-el-del-banco-0123456789');
    expect(run('/accounts', forged).sent.status).toBe(401);

    // Token real sin cons al que alguien le agrega cons: true a mano.
    const [h, , s] = sign(client()).split('.');
    const tampered = `${h}.${b64(client({ cons: true }))}.${s}`;
    expect(run('/accounts', tampered).sent).toEqual({
      status: 401,
      body: { statusCode: 401, message: 'Token inválido o expirado' },
    });
  });

  it('alg "none", token vencido o basura: 401', () => {
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(client({ cons: true }))}.`;
    expect(run('/accounts', none).sent.status).toBe(401);
    expect(run('/accounts', sign(client({ cons: true, exp: now - 10 }))).sent.status).toBe(401);
    expect(run('/accounts', 'no-es-un-jwt').sent.status).toBe(401);
  });

  it('el panel /admin no se ve afectado: los tokens de empleado pasan', () => {
    const staff = sign({ sub: 'staff-1', type: 'staff', role: 'admin', exp: now + 900 }, STAFF_SECRET);
    expect(run('/auth/admin/customers', staff).passed).toBe(true);
    expect(run('/fraud/admin/flags', staff).passed).toBe(true);
  });

  it('sin cons sí puede aceptar, ver el estado, renovar el token, iniciar sesión y registrarse', () => {
    const token = sign(client());
    expect(run('/auth/consentimientos', token, 'POST').passed).toBe(true);
    expect(run('/auth/consentimientos/estado', token).passed).toBe(true);
    expect(run('/auth/refresh-token', token, 'POST').passed).toBe(true);
    expect(run('/auth/login', token, 'POST').passed).toBe(true);
    expect(run('/auth/register', token, 'POST').passed).toBe(true);
    // Pero no pedir la clave dinámica (sirve para mover plata).
    expect(run('/auth/dynamic-key', token).sent.status).toBe(403);
  });

  it('sin token o en OPTIONS (CORS) pasa: el servicio decide', () => {
    expect(run('/payments/catalog').passed).toBe(true);
    expect(run('/accounts', sign(client()), 'OPTIONS').passed).toBe(true);
  });

  it('verifyHs256 revisa nbf y exp', () => {
    expect(verifyHs256(sign(client({ nbf: now + 60 })), SECRET)).toBeNull();
    expect(verifyHs256(sign(client()), SECRET)?.sub).toBe('cliente-1');
  });

  it('en producción no arranca sin JWT_SECRET (o con uno corto); fuera de producción se desactiva', () => {
    const env = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => consentGate(undefined)).toThrow(/JWT_SECRET/);
      expect(() => consentGate('corto')).toThrow(/JWT_SECRET/);
      process.env.NODE_ENV = 'development';
      const next = jest.fn();
      consentGate(undefined)({ method: 'GET', path: '/accounts', headers: {} } as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});
