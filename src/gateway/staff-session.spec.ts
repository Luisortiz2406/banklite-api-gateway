import type { NextFunction, Request, Response } from 'express';
import { staffSessionCheck } from './staff-session';

type Reply = { status: number; body?: unknown };

function fakeAuth(replies: Reply[]) {
  const calls: string[] = [];
  const fetchImpl = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(`${url} ${init.headers.Authorization}`);
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply.status === 0) throw new Error('ECONNREFUSED');
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  });
  return { fetchImpl, calls };
}

async function run(middleware: ReturnType<typeof staffSessionCheck>, path: string, token?: string, method = 'GET') {
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
  middleware(req, res, next);
  await new Promise((r) => setTimeout(r, 0));
  return { next, sent };
}

describe('Gateway: sesiones del panel administrativo', () => {
  it('deja pasar una sesión vigente', async () => {
    const { fetchImpl, calls } = fakeAuth([{ status: 200, body: { valid: true } }]);
    const mw = staffSessionCheck('http://auth', fetchImpl as never);
    const { next, sent } = await run(mw, '/kyc/admin/records', 'token-ok');
    expect(next).toHaveBeenCalled();
    expect(sent.status).toBeUndefined();
    expect(calls).toEqual(['http://auth/auth/admin/session Bearer token-ok']);
  });

  it('corta con 401 la sesión de un empleado desactivado o con otro rol', async () => {
    const { fetchImpl } = fakeAuth([{ status: 401, body: { message: 'Tu usuario del panel está desactivado.' } }]);
    const mw = staffSessionCheck('http://auth', fetchImpl as never);
    const { next, sent } = await run(mw, '/fraud/admin/flags', 'token-viejo');
    expect(next).not.toHaveBeenCalled();
    expect(sent).toEqual({ status: 401, body: { statusCode: 401, message: 'Tu usuario del panel está desactivado.' } });
  });

  it('recuerda la respuesta unos segundos (una sola consulta para varias peticiones)', async () => {
    const { fetchImpl } = fakeAuth([{ status: 200 }]);
    const mw = staffSessionCheck('http://auth', fetchImpl as never);
    await run(mw, '/accounts/admin/accounts', 'token-ok');
    await run(mw, '/ledger/admin/transactions', 'token-ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('si auth-service no responde, niega el paso (503)', async () => {
    const { fetchImpl } = fakeAuth([{ status: 0 }]);
    const mw = staffSessionCheck('http://auth', fetchImpl as never);
    const { next, sent } = await run(mw, '/compliance/admin/sars', 'token-ok');
    expect(next).not.toHaveBeenCalled();
    expect(sent.status).toBe(503);
  });

  it.each([
    ['rutas de clientes', '/accounts/me', 'token'],
    ['el login del panel', '/auth/admin/login', 'token'],
    ['peticiones sin token (el servicio responde 401)', '/kyc/admin/records', undefined],
  ])('no consulta a auth en %s', async (_label, path, token) => {
    const { fetchImpl } = fakeAuth([{ status: 200 }]);
    const mw = staffSessionCheck('http://auth', fetchImpl as never);
    const { next } = await run(mw, path, token);
    expect(next).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
