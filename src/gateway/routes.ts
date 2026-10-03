export interface UpstreamService {
  name: string;
  url: string;
  // Prefijos de ruta públicos que atiende este servicio.
  prefixes: string[];
}

// Cada microservicio expone rutas con un prefijo propio, así que el gateway
// enruta por prefijo sin reescribir la ruta.
export function loadUpstreams(): UpstreamService[] {
  const env = (key: string, fallback: string) => (process.env[key] || fallback).replace(/\/+$/, '');
  return [
    { name: 'auth-service', url: env('AUTH_SERVICE_URL', 'http://localhost:3001'), prefixes: ['/auth'] },
    { name: 'account-service', url: env('ACCOUNT_SERVICE_URL', 'http://localhost:3002'), prefixes: ['/accounts'] },
    { name: 'kyc-service', url: env('KYC_SERVICE_URL', 'http://localhost:3003'), prefixes: ['/kyc'] },
    { name: 'notification-service', url: env('NOTIFICATION_SERVICE_URL', 'http://localhost:3005'), prefixes: ['/notifications'] },
    { name: 'ledger-service', url: env('LEDGER_SERVICE_URL', 'http://localhost:3006'), prefixes: ['/ledger'] },
    { name: 'card-service', url: env('CARD_SERVICE_URL', 'http://localhost:3007'), prefixes: ['/cards'] },
    { name: 'transfer-service', url: env('TRANSFER_SERVICE_URL', 'http://localhost:3008'), prefixes: ['/transfers'] },
  ];
}

export function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

// Endpoints de servicio a servicio (protegidos con INTERNAL_API_KEY). Solo se
// llaman por la red privada; desde afuera el gateway responde 404.
const INTERNAL_ROUTES: { method?: string; pattern: RegExp }[] = [
  { pattern: /^\/internal(\/|$)/ },
  { pattern: /^\/ledger\/internal(\/|$)/ },
  { pattern: /^\/otp(\/|$)/ },
  { method: 'POST', pattern: /^\/notifications\/?$/ },
  { method: 'PATCH', pattern: /^\/kyc\/contact\/?$/ },
  { method: 'GET', pattern: /^\/kyc\/status(\/|$)/ },
];

export function isInternalRoute(method: string, path: string): boolean {
  return INTERNAL_ROUTES.some((r) => (!r.method || r.method === method) && r.pattern.test(path));
}
