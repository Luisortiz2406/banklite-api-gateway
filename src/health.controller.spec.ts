import { HealthController } from './health.controller';

type Reply = { status: number; body: unknown } | 'sin-respuesta';

/** Simula el /health de cada servicio según el host de la URL (auth-service, ledger-service, ...). */
function mockFetch(replies: Record<string, Reply>) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const name = Object.keys(replies).find((n) => url.includes(`${n}:`));
    const reply = name ? replies[name] : { status: 200, body: { status: 'ok', database: 'ok' } };
    if (reply === 'sin-respuesta') throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}

describe('GET /health del gateway', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    for (const [key, svc] of [
      ['AUTH_SERVICE_URL', 'auth-service:3001'],
      ['LEDGER_SERVICE_URL', 'ledger-service:3006'],
      ['CARD_SERVICE_URL', 'card-service:3007'],
    ]) {
      process.env[key] = `http://${svc}`;
    }
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it('todo en ok cuando cada servicio y su base responden', async () => {
    mockFetch({});
    const result = await new HealthController().check();
    expect(result.status).toBe('ok');
    expect(result.services).toHaveLength(12);
    expect(result.services.every((s) => s.status === 'ok' && s.database === 'ok')).toBe(true);
  });

  it('un servicio con la base caída (503) queda down y el total degraded', async () => {
    mockFetch({ 'ledger-service': { status: 503, body: { status: 'down', database: 'down' } } });
    const result = await new HealthController().check();
    const ledger = result.services.find((s) => s.name === 'ledger-service');
    expect(ledger).toMatchObject({ status: 'down', database: 'down' });
    expect(result.status).toBe('degraded');
  });

  it('un servicio que no responde queda down con la base desconocida', async () => {
    mockFetch({ 'card-service': 'sin-respuesta' });
    const result = await new HealthController().check();
    expect(result.services.find((s) => s.name === 'card-service')).toMatchObject({ status: 'down', database: 'unknown' });
    expect(result.status).toBe('degraded');
  });

  it('un 200 que no informa la base no cuenta como ok', async () => {
    mockFetch({ 'auth-service': { status: 200, body: { status: 'ok' } } });
    const result = await new HealthController().check();
    expect(result.services.find((s) => s.name === 'auth-service')).toMatchObject({ status: 'down', database: 'unknown' });
  });
});
