# API Gateway (`api-gateway`)

[![CI](https://github.com/Luisortiz2406/banklite-api-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-api-gateway/actions/workflows/ci.yml)

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
| `/deposits` | deposit-service | 3014 |

- **Bloquea las rutas internas** (`/internal/*`, `/ledger/internal/*`, `/otp/*`,
  `POST /notifications`, `PATCH /kyc/contact`, `GET /kyc/status/*`, `POST /ledger/transfers`):
  responde 404 desde afuera y nunca reenvía un `x-internal-key` que venga del cliente.
- Rechaza rutas ambiguas (barras dobles, `%2F`, `..`) antes de enrutar.
- **CORS** solo para los dominios del frontend (`CORS_ORIGINS`).
- **IP real del cliente**: la toma del encabezado del proxy de Railway (`CLIENT_IP_HEADER=x-real-ip`)
  o de la conexión directa, la valida y se la pasa a los servicios en `x-client-ip` (descarta la
  que mande el cliente). No se escribe en los logs. Comprobación: `GET /health/client-ip` con
  `CLIENT_IP_DEBUG=true` responde a quien llama solo su prefijo `/24` (o `/48`).
- **Límite de peticiones por IP del cliente**: global, rutas sensibles (login, registro) y envío de códigos.
- **Webhook de Wompi** (`POST /deposits/wompi/events`): ruta pública sin JWT (la autentica la firma
  del evento en deposit-service), con límite propio de peticiones por minuto y de tamaño del cuerpo
  (exige `Content-Length`: 411 sin él, 413 si supera `WEBHOOK_MAX_BODY_BYTES`).
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
| GET | `/health` | Estado de los 13 microservicios: por cada uno, `status` (arriba y con su base respondiendo), `database` (`ok`, `down` o `unknown` si el servicio no contestó) y latencia. El total es `ok` solo si todos lo están; si no, `degraded`. |
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
| `DEPOSIT_SERVICE_URL` | Sí | `http://localhost:3014` | URL interna de deposit-service. |
| `PROXY_TIMEOUT_MS` | No | `15000` | Espera máxima a un microservicio antes de responder 504. |
| `RATE_LIMIT_PER_MIN` | No | `300` | Peticiones por minuto por IP (global). |
| `RATE_LIMIT_SENSITIVE_PER_MIN` | No | `20` | Límite para rutas sensibles (login, registro). |
| `RATE_LIMIT_VERIFY_PER_MIN` | No | `10` | Límite para el envío de códigos de verificación. |
| `RATE_LIMIT_WEBHOOK_PER_MIN` | No | `60` | Límite del webhook de Wompi. |
| `WEBHOOK_MAX_BODY_BYTES` | No | `65536` | Tamaño máximo del cuerpo del webhook de Wompi. |
| `CLIENT_IP_HEADER` | En Railway | `x-real-ip` | Encabezado del proxy de entrada con la IP del cliente. Vacía: la conexión directa (local). |
| `CLIENT_IP_DEBUG` | No | `false` | `true` habilita `GET /health/client-ip` (prefijo y fuente de la IP de quien llama), solo para comprobar la configuración. |

## Pruebas

```bash
npm test
```

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`), con dominio público.
`railway.json` en la raíz define el build por `Dockerfile` y el health check en
`/health`; cada push a `main` redespliega el gateway.

- Gateway: https://api-gateway-production-dd7f.up.railway.app
- Estado de los 13 servicios y de sus bases: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health)
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-frontend](https://github.com/Luisortiz2406/banklite-frontend) | **Lo llama:** la aplicación web y el panel admin usan la API por el gateway |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Llama a:** `/auth` (registro, login, clave dinámica) y sesión del panel |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** `/accounts` (cuentas, límites, llaves Bre-B) |
| [banklite-kyc-service](https://github.com/Luisortiz2406/banklite-kyc-service) | **Llama a:** `/kyc` |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Llama a:** `/notifications` |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** `/ledger` (saldos y movimientos) |
| [banklite-card-service](https://github.com/Luisortiz2406/banklite-card-service) | **Llama a:** `/cards` |
| [banklite-transfer-service](https://github.com/Luisortiz2406/banklite-transfer-service) | **Llama a:** `/transfers` |
| [banklite-fraud-service](https://github.com/Luisortiz2406/banklite-fraud-service) | **Llama a:** `/fraud` (panel admin) |
| [banklite-compliance-service](https://github.com/Luisortiz2406/banklite-compliance-service) | **Llama a:** `/compliance` (panel admin) |
| [banklite-payment-service](https://github.com/Luisortiz2406/banklite-payment-service) | **Llama a:** `/payments` |
| [banklite-rewards-service](https://github.com/Luisortiz2406/banklite-rewards-service) | **Llama a:** `/rewards` |
| [banklite-savings-service](https://github.com/Luisortiz2406/banklite-savings-service) | **Llama a:** `/savings` |
| [banklite-deposit-service](https://github.com/Luisortiz2406/banklite-deposit-service) | **Llama a:** `/deposits` (recargas y webhook de Wompi) |
