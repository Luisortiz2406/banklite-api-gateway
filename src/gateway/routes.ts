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
    {
      name: 'notification-service',
      url: env('NOTIFICATION_SERVICE_URL', 'http://localhost:3005'),
      prefixes: ['/notifications'],
    },
    { name: 'ledger-service', url: env('LEDGER_SERVICE_URL', 'http://localhost:3006'), prefixes: ['/ledger'] },
    { name: 'card-service', url: env('CARD_SERVICE_URL', 'http://localhost:3007'), prefixes: ['/cards'] },
    { name: 'transfer-service', url: env('TRANSFER_SERVICE_URL', 'http://localhost:3008'), prefixes: ['/transfers'] },
    { name: 'fraud-service', url: env('FRAUD_SERVICE_URL', 'http://localhost:3009'), prefixes: ['/fraud'] },
    {
      name: 'compliance-service',
      url: env('COMPLIANCE_SERVICE_URL', 'http://localhost:3010'),
      prefixes: ['/compliance'],
    },
    { name: 'payment-service', url: env('PAYMENT_SERVICE_URL', 'http://localhost:3011'), prefixes: ['/payments'] },
    { name: 'rewards-service', url: env('REWARDS_SERVICE_URL', 'http://localhost:3012'), prefixes: ['/rewards'] },
    { name: 'savings-service', url: env('SAVINGS_SERVICE_URL', 'http://localhost:3013'), prefixes: ['/savings'] },
    { name: 'deposit-service', url: env('DEPOSIT_SERVICE_URL', 'http://localhost:3014'), prefixes: ['/deposits'] },
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
  // Las transferencias solo entran por transfer-service (que exige la clave
  // dinámica); nadie de afuera puede escribir directo en el ledger.
  { method: 'POST', pattern: /^\/ledger\/transfers\/?$/ },
];

/**
 * Rutas ambiguas que un servicio podría interpretar distinto que el gateway:
 * barras dobles, barras o puntos codificados (%2F, %5C, %2E), barra invertida
 * o segmentos '.' / '..'. Se rechazan antes de enrutar.
 */
export function isAmbiguousPath(rawPath: string): boolean {
  return /\/\/|\\|%2f|%5c|%2e|(^|\/)\.{1,2}(\/|$)/i.test(rawPath);
}

export function isInternalRoute(method: string, path: string): boolean {
  // Express enruta sin distinguir mayúsculas: '/Internal' llega al mismo endpoint.
  let normalized = path.toLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    return true; // codificación inválida: se trata como interna (404)
  }
  return INTERNAL_ROUTES.some((r) => (!r.method || r.method === method.toUpperCase()) && r.pattern.test(normalized));
}

/**
 * Webhooks de terceros (eventos de Wompi): rutas públicas sin JWT, autenticadas
 * por la firma del evento en el servicio. El gateway les aplica un límite de
 * peticiones y de tamaño del cuerpo propios.
 */
export function isWebhookRoute(method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && /^\/deposits\/wompi\/events\/?$/i.test(path);
}
