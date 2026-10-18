# API Gateway (`api-gateway`)

Único punto de entrada público de **BankLite**. Recibe todas las peticiones del
frontend y las reenvía al microservicio que corresponde según el prefijo de la ruta.

## Responsabilidad dentro de la arquitectura

- **Enrutamiento por prefijo**, sin reescribir la ruta ni el cuerpo:

| Prefijo | Microservicio | Puerto interno |
|---|---|---|
| `/auth` | auth-service | 3001 |
| `/accounts` | account-service | 3002 |
| `/kyc` | kyc-service | 3003 |
| `/notifications` | notification-service | 3005 |
| `/ledger` | ledger-service | 3006 |
| `/cards` | card-service | 3007 |
| `/transfers` | transfer-service | 3008 |
| `/fraud` | fraud-service | 3009 |
| `/compliance` | compliance-service | 3010 |
| `/payments` | payment-service | 3011 |
| `/rewards` | rewards-service | 3012 |
| `/savings` | savings-service | 3013 |

- **Bloquea las rutas internas** (`/internal/*`, `/ledger/internal/*`, `/otp/*`,
  `POST /notifications`, `PATCH /kyc/contact`, `GET /kyc/status/*`, `POST /ledger/transfers`):
  responde 404 desde afuera y nunca reenvía un `x-internal-key` que venga del cliente.
- Rechaza rutas ambiguas (barras dobles, `%2F`, `..`) antes de enrutar.
- **CORS** solo para los dominios del frontend (`CORS_ORIGINS`).
- **Límite de peticiones por IP**: global, rutas sensibles (login, registro) y envío de códigos.
- **Sesión del panel**: en cada ruta `/…/admin/` consulta `GET /auth/admin/session`
  (caché de 5 s); si auth-service no responde, falla cerrado con 503.
- Tiempo máximo de espera por servicio (`PROXY_TIMEOUT_MS`) → 504.

No tiene base de datos.

## Tecnologías

- Node.js 20, NestJS 10, TypeScript
- `http-proxy-middleware` (proxy sin `bodyParser`: el cuerpo se reenvía intacto)
- Docker y Railway

## Instalación y ejecución

```bash
npm ci
cp .env.example .env
npm run start:dev
```

Con Docker:

```bash
docker build -t banklite-api-gateway .
docker run --env-file .env -p 8080:8080 banklite-api-gateway
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del gateway y de los 12 microservicios (latencia de cada uno). |
| GET | `/` | Mapa de prefijos → microservicios. |
| * | `/<prefijo>/...` | Se reenvía al microservicio (ver tabla de arriba y el README de cada servicio). |

## Variables de entorno

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `8080` | Puerto HTTP del servicio. |
| `CORS_ORIGINS` | Sí | — | Dominios del frontend separados por comas (obligatoria en producción, sin `*`). |
| `AUTH_SERVICE_URL` | Sí | `http://localhost:3001` | URL interna de auth-service. |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `KYC_SERVICE_URL` | Sí | `http://localhost:3003` | URL interna de kyc-service. |
| `NOTIFICATION_SERVICE_URL` | Sí | `http://localhost:3005` | URL interna de notification-service. |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service. |
| `CARD_SERVICE_URL` | Sí | `http://localhost:3007` | URL interna de card-service. |
| `TRANSFER_SERVICE_URL` | Sí | `http://localhost:3008` | URL interna de transfer-service. |
| `FRAUD_SERVICE_URL` | Sí | `http://localhost:3009` | URL interna de fraud-service. |
| `COMPLIANCE_SERVICE_URL` | Sí | `http://localhost:3010` | URL interna de compliance-service. |
| `PAYMENT_SERVICE_URL` | Sí | `http://localhost:3011` | URL interna de payment-service. |
| `REWARDS_SERVICE_URL` | Sí | `http://localhost:3012` | URL interna de rewards-service. |
| `SAVINGS_SERVICE_URL` | Sí | `http://localhost:3013` | URL interna de savings-service. |
| `PROXY_TIMEOUT_MS` | No | `15000` | Espera máxima a un microservicio antes de responder 504. |
| `RATE_LIMIT_PER_MIN` | No | `300` | Peticiones por minuto por IP (global). |
| `RATE_LIMIT_SENSITIVE_PER_MIN` | No | `20` | Límite para rutas sensibles (login, registro). |
| `RATE_LIMIT_VERIFY_PER_MIN` | No | `10` | Límite para el envío de códigos de verificación. |

## Pruebas

```bash
npm test
```

## Despliegue

Desplegado en Railway con dominio público:

- Gateway: https://api-gateway-production-dd7f.up.railway.app · estado: https://api-gateway-production-dd7f.up.railway.app/health
- Aplicación web: https://frontend-production-eff3c.up.railway.app
