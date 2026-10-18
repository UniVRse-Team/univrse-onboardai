# Cloud Run services

In the cloud, OnboardAi runs as three separate Cloud Run services built from one `Dockerfile`. Each has its own Docker target and starts from its own file in `server/`. Every service listens on `HOST` (default `0.0.0.0`) and `PORT` (default `8080`) and stops cleanly on SIGTERM.

| Service | Entry file               | Docker target | Health path   | What it does                                                                                                        |
| ------- | ------------------------ | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `web`   | `server/web-service.mjs` | `web`         | `/web-health` | Serves `dist/` and the avatar, and proxies `/api/*` to the api service. Holds no secrets.                           |
| `api`   | `server/api-service.mjs` | `api`         | `/api/health` | Serves every `/api/*` route: accounts, chat, saved conversations, onboarding journey, document search, `/api/voice` |
| `tts`   | `server/tts-service.mjs` | `tts`         | `/health`     | `POST /voice` renders speech with Kokoro. `/health` returns 503 until the model has loaded.                         |

The `tts` image carries the Kokoro model (downloaded at build time by `npm run voice:prepare`). The `web` image carries `dist/`. The `api` image carries neither.

### Checking the api -> tts hop

`GET /api/health/tts` on the api needs no sign-in and never renders speech. With `TTS_SERVICE_URL` set it makes one `GET /health` call to the tts service (5 second limit), carrying the api's ID token when service auth is on, and answers `200 {"ok":true,"tts":"ok"}` when that call succeeds. It answers `503 {"ok":false,"tts":"unavailable"}` on any other result, including when no ID token can be minted (nothing is sent unsigned). Without `TTS_SERVICE_URL` (in-process voice) it answers `200 {"ok":true,"tts":"local"}`. The deploy smoke test uses it because `/api/voice` needs a signed-in account.

## Settings each service reads

| Service | Variable                                                                                                                                                 | Meaning                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| all     | `HOST`, `PORT`                                                                                                                                           | Where to listen. Defaults `0.0.0.0` and `8080`.                                                                             |
| web     | `API_SERVICE_URL`                                                                                                                                        | Required. Base URL of the api service. The web service refuses to start without a valid http(s) URL.                        |
| web     | `TRUST_PROXY`                                                                                                                                            | Trusted proxy hops. Default `1`.                                                                                            |
| web     | `SERVICE_AUTH`                                                                                                                                           | ID tokens for the web -> api hop: unset (automatic), `none` or `id-token`. See [Private api and tts](#private-api-and-tts). |
| api     | `TTS_SERVICE_URL`                                                                                                                                        | Base URL of the tts service. If unset, the api loads Kokoro in its own process instead.                                     |
| api     | `TRUST_PROXY`                                                                                                                                            | Trusted proxy hops. Default `2`.                                                                                            |
| api     | `SERVICE_AUTH`                                                                                                                                           | ID tokens for the api -> tts hop: unset (automatic), `none` or `id-token`. See [Private api and tts](#private-api-and-tts). |
| api     | `AI_MODE`, `GEMINI_MODEL`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `VERTEX_SEARCH_LOCATION`, `VERTEX_SEARCH_ENGINE_ID`, `FIRESTORE_DATABASE_ID` | Same meaning as in `.env.example`. Vertex AI Search: see [chat and memory](chat-and-memory.md).                             |
| tts     | `KOKORO_CACHE_DIR`                                                                                                                                       | Where the baked-in model lives. Default `.cache/kokoro`. Nothing is downloaded at start-up.                                 |

`GOOGLE_CLOUD_TTS=enabled` turns on the legacy billed Cloud Text-to-Speech route; it is off by default and for local use only.

`TRUST_PROXY` accepts a number, `true`, `false`, or an Express trust-proxy string. A `.env` file in the working directory is also loaded.

## Request flow

```
browser -> web -> api -> tts
```

The browser only ever talks to the web origin. `/api/*` is a same-origin request to web, which forwards it to api; the api calls tts only for `/api/voice`. On Cloud Run, web signs each forwarded request and api signs each tts call with a Google ID token (see [Private api and tts](#private-api-and-tts)). This keeps the `onboardai_account` session cookie first-party (it is `httpOnly`, `sameSite=strict`, path `/api`), so it keeps working and the api's same-origin check still makes sense. The proxy passes the api's `Set-Cookie` headers back unchanged, streams the response, and answers 502 or 504 if the api is down or too slow. Request bodies are limited to 64 KiB, except raw file uploads (`application/octet-stream`) to `/api/hr/company-knowledge/documents` and `/api/hr/employees/autofill`, which may be 5 MiB (a larger autofill file gets the api's own `413 AUTOFILL_FILE_TOO_LARGE` answer), and `/api/me/document-submissions`, which may be 25 MiB (`413 FILE_TOO_LARGE`).

## Trusted proxy hops

The api needs the end user's IP (rate limit) and the public host (origin check), but it sits behind two hops.

- **web, `TRUST_PROXY=1`**: one hop is Google's front end, which appends the browser's IP to `X-Forwarded-For`. Express therefore reads the browser's IP and host.
- **api, `TRUST_PROXY=2`**: two hops are Google's front end for the api service (it appends the web instance's address) and the web instance itself. The web proxy discards any `X-Forwarded-*` the browser sent, then sends its own `X-Forwarded-For` (ending in the browser's IP), `X-Forwarded-Host` and `X-Forwarded-Proto`. With two hops, Express skips the web instance and the api sees the browser's IP.

What this affects:

- **Rate limit**: the api allows 60 `POST` and `PATCH` requests per minute per `req.ip` (raised from 30 for the longer v3 onboarding checklist). Because of the hops above, that key is the end user's IP, not Google's or web's. The count is kept in memory, so each api instance has its own; this is one reason the api runs with `max-instances=1` (see [Conversation storage](#conversation-storage)).
- **Origin check**: saved-conversation routes compare the `Origin` header's host with `req.host`. Behind the proxy that is the forwarded host, i.e. the host the browser used on the web service.

If you change the number of proxies in front of either service (a load balancer, IAP), change `TRUST_PROXY` to match.

## Private api and tts

Only web is public. The api and tts services do not allow `allUsers`; Cloud Run lets a request through only with a Google-signed ID token of a principal that may invoke the service:

| Service | Who may invoke it                                                                                                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`   | everyone (`allUsers`, `roles/run.invoker`)                                                                                                                                                                                                                                                                                                   |
| `api`   | the web runtime service account `onboardai-web-run[-staging]` (`roles/run.invoker`); on staging also the intake agent's `onboardai-intake-staging` (`roles/run.invoker`, for #27's `/mcp`); the deployer `onboardai-deployer[-staging]` through its Cloud Run Developer role (`run.routes.invoke`), which the smoke test's `/mcp` check uses |
| `tts`   | the api runtime service account `onboardai-api-run[-staging]` (`roles/run.invoker`); the deployer, through Cloud Run Developer                                                                                                                                                                                                               |

The IAM bindings are in Terraform ([`terraform/onboardai/cloud_run.tf`](../terraform/onboardai/cloud_run.tf); the intake agent's is in `intake_agent.tf`). **Rollout order:** deploy the app first (it sends ID tokens as soon as it runs on Cloud Run with https URLs), then apply the invoker grants, then remove `allUsers` from the api and tts. Removing `allUsers` before the new app and the grants are both live makes Cloud Run refuse web's calls to the api (and the api's to tts). The steps are in the Terraform README, [Private api and tts](../terraform/onboardai/README.md#private-api-and-tts). The code side is `server/service-auth.mjs`, used by both hops: the web proxy (`server/api-proxy.mjs`) and the api's voice client (`server/remote-voice.mjs`).

- **Header.** The token is sent as `X-Serverless-Authorization: Bearer <ID token>`. Cloud Run checks that header instead of `Authorization` when it is present, so `Authorization` stays free for application-level auth and passes through the proxy unchanged.
- **Audience.** The target service's origin, for example `https://onboardai-api-staging-jxwligh3kq-as.a.run.app` (the URL in `API_SERVICE_URL` or `TTS_SERVICE_URL`, without its path).
- **Minting.** `google-auth-library`: `new GoogleAuth().getIdTokenClient(audience)`, one client per audience per process, created at the first request. On Cloud Run the token comes from the metadata server as the service's runtime service account. The client caches the token until shortly before it expires.
- **Browser headers.** The proxy always drops an `X-Serverless-Authorization` header sent by the browser, then adds its own when ID tokens are on. Everything else the browser sends is forwarded as before.
- **Failures.** If no token can be minted, the proxy answers `502 { "code": "API_UNAVAILABLE", "error": "The assistant is temporarily unavailable. Please try again shortly." }`, the same answer as an unreachable api, and `/api/voice` answers its usual `503 VOICE_UNAVAILABLE`. The request is not sent unsigned. The service logs one line naming the hop and an error code, for example `Service-to-service ID token for web -> api failed: ENOENT.` (`NO_ID_TOKEN_CREDENTIALS` when the credentials cannot mint ID tokens at all), never the token.
- **Start-up.** web and api each log whether ID tokens are on for their hop, with the audience, for example `Service-to-service ID tokens for web -> api: on (audience https://onboardai-api-staging-jxwligh3kq-as.a.run.app; on Cloud Run).`

`SERVICE_AUTH` decides when a token is sent:

| `SERVICE_AUTH` | ID token sent                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| unset or blank | only on Cloud Run (`K_SERVICE` is set) **and** when the target URL is `https`. This is the default in the cloud. |
| `none`         | never                                                                                                            |
| `id-token`     | always. The service refuses to start if the target URL is not `https`.                                           |

Any other value stops the service at start-up. Locally (`npm run dev`, the three-process setup below, `npm run local` and the tests) `K_SERVICE` is unset and the URLs are `http`, so nothing is minted, the metadata server is never called and requests are unchanged. Forcing `SERVICE_AUTH=id-token` on a laptop mints with your Application Default Credentials. With user credentials (`gcloud auth application-default login`) google-auth-library returns a Google-signed ID token whose audience is the OAuth client of those credentials, not the service origin, so it only exercises the code path; without usable credentials every request ends in the 502 above.

Once the IAM is applied, Cloud Run refuses a direct request to the api or tts URL before it reaches the service: `403` without a token, `401` with an invalid one. That closes the gap the api had while it was public: a client can no longer reach the api with its own `X-Forwarded-For` (rate limit evasion or aiming it at another IP) or a forged forwarded host. The web service stays public; putting IAP in front of it is #10.

**Calling the api or tts by hand.** Go through web (`https://<web URL>/api/...` reaches the api), or open an authenticated tunnel with `gcloud run services proxy`, which signs each request as your gcloud account. That account needs `run.routes.invoke` on the service (for example Cloud Run Invoker).

```bash
gcloud run services proxy onboardai-api-staging --region=asia-southeast1 --port=8082
curl localhost:8082/api/health
gcloud run services proxy onboardai-tts-staging --region=asia-southeast1 --port=8081
curl localhost:8081/health
```

Production's services are `onboardai-api` and `onboardai-tts`.

### Other callers of the api

Any other service that calls the api directly needs the api's invoker role for its own service account and must send its ID token (audience: the api origin) in `X-Serverless-Authorization`. The employee form intake agent (#27) is one: on staging its service account `onboardai-intake-staging` holds `roles/run.invoker` on the api for `/mcp`. It must send its ID token in `X-Serverless-Authorization`, because its `Authorization` header carries its MCP bearer token for the app; an ID token in `Authorization` would replace that bearer.

## The avatar

`/avatars/alya/alya.glb` is the pre-compressed `alya.glb.gz` (22,085,850 bytes, about 21 MiB; the ALYA model of #61) sent with `Content-Encoding: gzip`. It is streamed **without** a `Content-Length`, so Node uses chunked transfer. Cloud Run caps HTTP/1 responses that are not chunked at 32 MiB; the current file is under that, and streaming keeps a larger model working. The shared code is `server/avatar-route.mjs`, used by both the web service and `server/index.mjs`.

## Conversation storage

In the cloud the api sets `FIRESTORE_DATABASE_ID` (`(default)` in production, `onboardai-staging` in staging), so saved chats, answer-style settings, support observations and LangGraph checkpoints are in Firestore and survive restarts and redeploys. It authenticates as the api runtime service account, which holds `roles/datastore.user` on that database only. Chats under the same browser cookie are shared by every api instance, and an answer leases its chat in Firestore, so storage no longer needs `max-instances=1`. The remaining per-instance state is the rate limit above (moving it off the instance is #58). Layout, retention and errors: [Where chats are stored](chat-and-memory.md#where-chats-are-stored).

Without `FIRESTORE_DATABASE_ID` the api falls back to SQLite in `.cache/chat/conversations.sqlite` on the instance's disk (override with `CHAT_DATABASE_PATH`). That disk is lost on restart or redeploy, and SQLite only suits one instance, so it is for local development.

## Deploy order and where it happens

Deploy **tts, then api, then web**, because each needs the URL of the one before it (`TTS_SERVICE_URL`, then `API_SERVICE_URL`).

- Automatic deploys: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), on pushes to `staging` (the staging services) and `main` (production).
- Infrastructure (services, service accounts, secrets, scaling): the Terraform module [`terraform/onboardai/`](../terraform/onboardai/).

Their contents are not repeated here.

## Local development

`npm run dev` and `npm start` are unchanged: they run `server/index.mjs`, one process with the website, the api routes and the in-process voice, and no proxy.

To run the three services as separate processes (run `npm run build` first for `dist/`, and `npm run voice:prepare` for the voice model):

```bash
PORT=8081 node server/tts-service.mjs
PORT=8082 TTS_SERVICE_URL=http://127.0.0.1:8081 node server/api-service.mjs
PORT=8080 API_SERVICE_URL=http://127.0.0.1:8082 node server/web-service.mjs
```

Then open `http://localhost:8080`. Leave `TTS_SERVICE_URL` out to let the api load the voice itself. Check with `curl localhost:8080/web-health` and `curl localhost:8080/api/health`. Leave `SERVICE_AUTH` unset: with `http` URLs and no `K_SERVICE`, no ID tokens are sent and both services log `off`.
