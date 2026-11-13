import { isAmbiguousPath, isInternalRoute, isWebhookRoute, loadUpstreams, matchesPrefix } from './routes';

describe('rutas del gateway', () => {
  describe('loadUpstreams', () => {
    const env = process.env;
    afterEach(() => {
      process.env = env;
    });

    it('publica los 13 servicios, cada uno con su prefijo, y por defecto apuntan a localhost', () => {
      const upstreams = loadUpstreams();

      expect(upstreams).toHaveLength(13);
      expect(upstreams.find((s) => s.name === 'auth-service')).toEqual({
        name: 'auth-service',
        url: 'http://localhost:3001',
        prefixes: ['/auth'],
      });
      expect(upstreams.flatMap((s) => s.prefixes).sort()).toEqual(
        [
          '/accounts',
          '/auth',
          '/cards',
          '/compliance',
          '/deposits',
          '/fraud',
          '/kyc',
          '/ledger',
          '/notifications',
          '/payments',
          '/rewards',
          '/savings',
          '/transfers',
        ].sort(),
      );
    });

    it('la URL de cada servicio sale del entorno, sin barras al final', () => {
      process.env = { ...env, LEDGER_SERVICE_URL: 'http://ledger.railway.internal:3006///' };
      expect(loadUpstreams().find((s) => s.name === 'ledger-service')?.url).toBe('http://ledger.railway.internal:3006');
    });
  });

  describe('matchesPrefix', () => {
    it('coincide con el prefijo exacto o con una subruta, no con un prefijo parecido', () => {
      expect(matchesPrefix('/auth', '/auth')).toBe(true);
      expect(matchesPrefix('/auth/login', '/auth')).toBe(true);
      expect(matchesPrefix('/authentic', '/auth')).toBe(false);
      expect(matchesPrefix('/x/auth', '/auth')).toBe(false);
    });
  });

  describe('rutas internas (servicio a servicio): desde afuera dan 404', () => {
    it.each([
      ['GET', '/internal/anything'],
      ['GET', '/metrics'],
      ['POST', '/metrics/'],
      ['GET', '/METRICS'],
      ['GET', '/metrics/otra'],
      ['POST', '/ledger/internal/rewards'],
      ['GET', '/otp/send'],
      ['POST', '/notifications'],
      ['POST', '/notifications/'],
      ['PATCH', '/kyc/contact'],
      ['GET', '/kyc/status/abc'],
      ['POST', '/ledger/transfers'],
    ])('%s %s es interna', (method, path) => {
      expect(isInternalRoute(method, path)).toBe(true);
    });

    it('no distingue mayúsculas ni rutas codificadas, y una codificación inválida se trata como interna', () => {
      expect(isInternalRoute('GET', '/Internal/x')).toBe(true);
      expect(isInternalRoute('GET', '/%69nternal/x')).toBe(true);
      expect(isInternalRoute('post', '/LEDGER/transfers')).toBe(true);
      expect(isInternalRoute('GET', '/%E0%A4%A')).toBe(true);
    });

    it('las rutas públicas de los mismos servicios no se bloquean', () => {
      expect(isInternalRoute('GET', '/notifications')).toBe(false);
      expect(isInternalRoute('POST', '/kyc/submit')).toBe(false);
      expect(isInternalRoute('GET', '/kyc/abc')).toBe(false);
      expect(isInternalRoute('GET', '/ledger/transfers')).toBe(false);
      expect(isInternalRoute('POST', '/auth/login')).toBe(false);
      expect(isInternalRoute('GET', '/internals')).toBe(false);
    });
  });

  describe('rutas ambiguas', () => {
    it.each([
      '//auth/login',
      '/auth//login',
      '/a\\b',
      '/auth%2flogin',
      '/auth%5Clogin',
      '/%2e%2e/x',
      '/a/../b',
      '/a/./b',
      '/..',
    ])('%s se rechaza', (path) => {
      expect(isAmbiguousPath(path)).toBe(true);
    });

    it('las rutas normales pasan, incluso con puntos dentro de un segmento', () => {
      expect(isAmbiguousPath('/auth/login')).toBe(false);
      expect(isAmbiguousPath('/accounts/1.2.3')).toBe(false);
      expect(isAmbiguousPath('/')).toBe(false);
    });
  });

  it('el webhook de Wompi es POST a /deposits/wompi/events, sin importar mayúsculas ni la barra final', () => {
    expect(isWebhookRoute('post', '/Deposits/Wompi/Events/')).toBe(true);
    expect(isWebhookRoute('GET', '/deposits/wompi/events')).toBe(false);
    expect(isWebhookRoute('POST', '/deposits/wompi/events/x')).toBe(false);
  });
});
