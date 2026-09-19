# MCPRouter — Design

Ngày: 2026-09-19 · Trạng thái: chờ review · Tham chiếu học tập: `samanhappy/mcphub` (Apache-2.0)

Tài liệu này là WHAT và WHY. Bản chi tiết từng subsystem nằm ở `docs/superpowers/designs/*.json`
(10 file, sản phẩm của 10 agent thiết kế độc lập). Chỗ nào tài liệu này mâu thuẫn với các file đó,
tài liệu này thắng — nó đã hoà giải các mâu thuẫn giữa chúng.

---

## 1. Bối cảnh và định vị

MCPRouter là một MCP gateway: gom nhiều upstream MCP server lại sau một endpoint duy nhất,
kiểm soát tool nào lộ ra cho client nào, và cho operator thấy chuyện gì đang xảy ra.

Định vị: **bản thay thế gọn hơn MCPHub**. Cùng bài toán, ít code hơn nhiều, console vận hành tốt hơn hẳn.
Không phải fork. Viết lại từ đầu, học kiến trúc và học cả những lỗi họ đã trả giá để tìm ra.

Đối tượng triển khai: **team tự host, nhiều người dùng**. Không phải SaaS multi-tenant, không phải local single-user.

### Quyết định đã khoá

| | |
|---|---|
| Ngôn ngữ | TypeScript / Node ESM, `@modelcontextprotocol/sdk` cả phía client lẫn server |
| Cấu trúc | pnpm monorepo, **một process**: `packages/core` (engine, không biết HTTP) · `packages/server` (Hono + MCP endpoint) · `packages/web` (React SPA) · `packages/cli` |
| Lưu trữ | **Chỉ** Postgres 16 + pgvector. Không chế độ JSON file, không SQLite, không DAO hai tầng. Drizzle với file migration thật |
| MVP | Gồm **cả bốn**: Context Cost · Observability thật · Smart Routing · Marketplace/install |
| UI | Terminal / control-plane. Dark-first, mono cho mọi định danh, grid dày, status dot, stream trực tiếp |

### Học thuyết thiết kế

Dừng ở nấc thang đầu tiên còn đứng vững: *thứ này có cần tồn tại không* → *SDK/stdlib/platform đã làm chưa* →
*dependency đã cài có đủ không* → *một dòng được không* → chỉ khi đó mới viết code.
Không interface cho một implementation. Không factory cho một sản phẩm. Không config cho giá trị không bao giờ đổi.

**Không bao giờ đơn giản hoá mất**: validate ở biên tin cậy, xử lý lỗi chống mất dữ liệu, biện pháp bảo mật, nền a11y.
Mọi chỗ cắt góc có chủ ý phải ghi rõ trần và đường nâng cấp.

---

## 2. Thực tế giao thức — ràng buộc quan trọng nhất

Spec MCP bản `2026-07-28` **xoá bỏ session ở tầng giao thức**:

| | Legacy (≤ `2025-11-25`) | Modern (`2026-07-28`) |
|---|---|---|
| Bắt tay | `initialize` → session | Không có. Mỗi request tự mang version + capabilities trong `_meta` |
| `Mcp-Session-Id` | Server cấp, DELETE để huỷ | Bỏ. Nhận được thì ignore, không mint, không echo |
| GET stream | Có | Bỏ → `405` |
| `Last-Event-ID` resume | Có | Bỏ. Stream không resume |
| Server→client request | Gửi thẳng trên SSE | Bỏ. Thay bằng MRTR (`InputRequiredResult` + `inputRequests`/`inputResponses`) |
| Notification dài hạn | GET stream | `subscriptions/listen`, response stream của chính nó giữ mở |
| Header bắt buộc | — | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`. Server **MUST**验 header khớp body, lệch → `-32020 HeaderMismatch` |
| Đăng ký client | DCR (RFC 7591) | DCR **deprecated**. CIMD là cơ chế khuyến nghị |

Còn đúng hai transport chuẩn: **stdio** và **Streamable HTTP**. Transport HTTP+SSE hai endpoint
(`/sse` + `/messages`, bản `2024-11-05`) deprecated từ `2025-03-26`, đang chờ xoá.

**Nhưng SDK chưa theo kịp.** Kiểm chứng bằng cách giải nén tarball đã publish:

```
@modelcontextprotocol/sdk@1.30.0
  LATEST_PROTOCOL_VERSION     = '2025-11-25'
  SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']
```

### Hệ quả — quy tắc kiến trúc số 1

v1 **phải** phục vụ legacy-era `2025-11-25` Streamable HTTP, vì đó là thứ SDK và mọi client thật đang nói.
Nhưng **era là một adapter mỏng ở rìa HTTP**. Chuỗi ký tự `'session'` **không được phép xuất hiện trong `packages/core`**.

Phần thưởng: toàn bộ lớp nợ session của mcphub — `enableSessionRebuild` hồi sinh internal riêng tư của SDK
(`sseService.ts:105`), re-inject group từ session trước khi check scope (`:166,705,855`) — là **nợ chuyển tiếp**
mà chính spec đang tự xoá. Rìa càng mỏng, ta thừa kế càng ít.

Ta còn đi xa hơn: **v1 stateless luôn ở phía downstream.** `initialize` **không** cấp `Mcp-Session-Id`;
`Mcp-Session-Id` gửi đến bị ignore hoàn toàn; GET/DELETE trả `405`. Scope được tính lại từ URL + credential
trên **mọi** POST. Xoá sạch: session map, binding session→group, bài toán sống sót qua restart,
và check session/route mismatch. Cái fix bảo mật mcphub phải trả giá mới có trở thành **con đường code duy nhất**.

Hedge, nếu test tương thích cho thấy client thật bắt buộc phải có session id: mint một id **trang trí** —
random, echo ở `initialize`, chấp nhận ở mọi POST sau đó, **không bao giờ tra cứu**.
Sau cờ `MCP_EMIT_SESSION_ID`, mặc định tắt. 10 LOC, vẫn zero state.

---

## 3. Học được gì từ MCPHub

### Sao chép — họ đã trả giá để có

| Hành vi | Bằng chứng |
|---|---|
| Enforce enable/disable **lúc gọi**, không chỉ lúc list | Fix CVE `afcc72f` của họ. Disabled tool vẫn gọi được qua `tools/call` |
| Lỗi tool bị ẩn ≡ lỗi tool không tồn tại, **byte-identical** | `ToolUnavailableError` (`mcpService.ts:2654`). Chống dò |
| Generation counter + identity guard trên connect bất đồng bộ | `:832`, `:2025`, `:2035`. Connect chậm không ghi đè state đã bị thay |
| SSRF validate trên URL upstream **và mọi hop redirect** | `:1382-1396` |
| Namespace `<server><sep><tool>` ngay lúc cache | `normalizeToolForCache :638`. Collision không thể xảy ra |
| Đẩy scope vào **SQL** của vector search, không filter sau `LIMIT` | Bug `a6f3747` của chính họ |
| Full-containment cho key scope theo server khi vào route group | GHSA-454m-4vm6-842f, `sseService.ts:228-302` |
| Group = membership + item selection trong **một** record | `entities/Group.ts:23-33`. Hình dạng này đúng, giữ nguyên |

### Tránh — chính là chỗ để gọn hơn

| Nợ của mcphub | Hậu quả | MCPRouter |
|---|---|---|
| Dual storage JSON DAO + TypeORM | Thêm 1 field = sửa **7 lớp** (AGENTS.md của họ tự ghi) | Một backend. Thêm field = sửa 1 zod schema, hoặc 1 cột + 1 migration |
| `mcpService.ts` **5006 dòng**, global `serverInfos` mutable | Phần lớn comment đáng sợ nhất là vá race | 1 `UpstreamServer` per server, state machine thuần |
| `synchronize: true`, không migration | Không nâng cấp an toàn | Drizzle migration file, CI gate `git diff --exit-code drizzle/` |
| `:group` nhận group-name \| UUID \| server-name \| `$smart` | Server trùng tên group bị nuốt **im lặng** | Path tường minh, kind nằm trong literal segment |
| 5 stack auth song song | 5 storage, 5 lifecycle | 3 loại credential, **một** verifier là better-auth |
| API key all-access ⇒ `isAdmin: true` (`auth.ts:132-141`) | Lộ 1 key = lộ **mọi** secret upstream plaintext | `admin: false` là **literal type** ở nhánh machine của `Principal` |
| Bearer key plaintext, scan O(n) mỗi request (`auth.ts:37-56`) | Chậm + lộ DB là lộ hết | better-auth apiKey plugin. Ta không viết dòng nào về lưu key |
| `env`/`headers`/OAuth token upstream plaintext | Như trên | `seal`/`open` duy nhất, AES-256-GCM, AAD theo ID |
| `owner === undefined` visible với mọi người (`DaoConfigService:171`) | 2 đường authz bất đồng | Xoá hẳn trục per-resource (xem §5) |
| `group.visibility == null` mở route cho mọi user đã auth | Như trên | Như trên |
| FE: 2 design system đánh nhau, **284 `!important`**, không `@theme` | 1000+ class `text-gray-*` raw còn sót | `@theme inline` định nghĩa cả token của ta **và** mọi tên shadcn phát ra |
| Status poll 30s | Gateway mà upstream flap trong vài giây | 1 kênh SSE đẩy status |
| `SettingsPage.tsx` **3928 dòng** accordion | Không deep-link được setting nào | Sinh từ **một** zod schema |
| Log ring 1000 in-memory qua monkey-patch `console.*` | Mất sạch khi restart | pino → stdout NDJSON, ring chỉ để live view |
| Không `/metrics`, không trace, không request-ID | Docs của họ tự thừa nhận, đẩy sang APM ngoài | Đây là điểm khác biệt chính, xem §8 |
| `servers.json` 2.4 MB parse lại **mỗi request** | | 1 catalog, cache Postgres |
| CI: job build và integration **bị comment hết** (`ci.yml:48-113`), coverage threshold = **0** | | Gate ở số cuối cùng ngay từ P0 |
| `mcp_settings.json` ship sẵn `admin/admin123` | | Token 256-bit in ra boot log, claim một lần |

---

## 4. Kiến trúc

```
packages/core     MCP engine + Drizzle schema + migrations
                  deps: sdk, zod, drizzle, pino, pg
                  CẤM: hono, better-auth        <-- cưỡng chế bởi pnpm isolated node_modules
      ^
      |
packages/server   Hono + better-auth + rìa HTTP/MCP
                  sở hữu: era adapter, route, SSE, REST admin API

packages/web      Vite SPA. Không phụ thuộc TS vào hai cái trên
packages/cli      import type-only từ core. Zero runtime workspace dep
```

Chiều phụ thuộc một chiều, cưỡng chế **hai lần**: `references` trong tsconfig, và pnpm isolated
node_modules khiến `import { Hono } from 'hono'` bên trong core **fail lúc resolve**, không phải fail lúc review.

Đây chính là cơ chế giữ cho ước lượng "1 tuần thêm modern era" là thật.

### 4.1 Engine — `packages/core`

Sở hữu đúng một thứ: tập kết nối MCP upstream đang sống, và catalog tool/prompt/resource chiếu ra từ chúng.
Không HTTP, không session, không authz, không lưu config.

**Ý tưởng cốt lõi: scope là tham số, không bao giờ là state.** Mọi method public là
`(scope: ResolvedScope, principal: Principal) => result`. Core không bao giờ phân giải tên group,
không parse URL, không thấy session id, không ra quyết định authz. `ResolvedScope` tới nơi **đã được authorize sẵn**.

**Một predicate trả lời cả hai câu hỏi.** `isExposed(scope, serverName, kind, bareName)` dùng cho cả
`listTools` lẫn `callTool`. `resolveTool` ném `ToolUnavailableError` với đúng một message
`Tool not found: ${name}`, dựng ở **đúng một chỗ**, cho mọi trường hợp: thiếu / bị disable /
ngoài group / server chết. CVE `afcc72f` của mcphub trở thành *không thể tái phát về mặt cấu trúc*.

**`TransportFactory` injectable** là test seam (MCP server in-process qua `InMemoryTransport` —
không child process, không port) **và** là cửa cho OpenAPI-as-MCP sau này.

~1.770 dòng nguồn thay cho 5.006 dòng của `mcpService.ts`.

#### State machine kết nối

```ts
// packages/core/src/state.ts — THUẦN. Không I/O, không timer, không chạm instance.
export type State =
  | 'disabled' | 'idle' | 'connecting' | 'discovering' | 'ready'
  | 'retrying' | 'authRequired' | 'failed' | 'stopping' | 'closed';

const FAIL   = '@fail'   as const;   // -> ev.permanent ? 'failed' : 'retrying'
const INTENT = '@intent' as const;   // -> intent đã bắt tại `stop`

export const TABLE: Record<State, Partial<Record<Ev['t'], State | '@fail' | '@intent'>>> = {
  disabled:     { enable: 'idle', stop: 'closed' },
  idle:         { start: 'connecting', disable: 'disabled', stop: 'closed' },
  connecting:   { connectOk: 'discovering', connectFail: FAIL,
                  transportClose: 'retrying', authChallenge: 'authRequired',
                  stop: 'stopping', disable: 'stopping' },
  discovering:  { discoverOk: 'ready', discoverFail: FAIL,
                  transportClose: 'retrying', authChallenge: 'authRequired',
                  stop: 'stopping', disable: 'stopping' },
  ready:        { refresh: 'ready', transportClose: 'retrying',
                  authChallenge: 'authRequired',
                  stop: 'stopping', disable: 'stopping' },
  retrying:     { backoffElapsed: 'connecting', giveUp: 'failed',
                  stop: 'closed', disable: 'disabled' },
  authRequired: { authResolved: 'connecting', start: 'connecting',
                  stop: 'closed', disable: 'disabled' },
  failed:       { start: 'connecting', stop: 'closed', disable: 'disabled' },
  stopping:     { stopped: INTENT },   // mọi event khác bị DROP
  closed:       { },                   // TERMINAL: nuốt tất cả
};

/** undefined => cặp bất hợp lệ => DROP (debug log). Không bao giờ throw. */
export function next(s: State, ev: Ev, intent: State): State | undefined { /* ... */ }
```

Terminal duy nhất: `closed`. Tĩnh-nhưng-vào-lại-được: `disabled` (cần `enable`),
`failed` (cần `start` = operator reload hoặc đổi config), `authRequired` (cần `authResolved` từ OAuth callback).

Side effect nằm ở `UpstreamServer.dispatch()`, khoá theo transition:
`→connecting` = `epoch++`, lấy connect semaphore, dựng transport, `client.connect`.
`→ready` = hoán đổi catalog snapshot immutable trong **một** phép gán (Node đơn luồng: atomic, không cần lock).
`→retrying` = **giữ** catalog cũ và đặt `stale=true`, backoff full-jitter `min(1000*2^attempt, 30000)`.
`→stopping` = abort AbortController, `client.close()`, `kill(-pid)` rồi `SIGKILL` sau 5s.

Lỗi **permanent** (→ `failed`): `ENOENT`/`EACCES` khi spawn, DNS NXDOMAIN, SSRF reject,
`${VAR}` không phân giải được, 401 khi không có authProvider, 404 trên MCP endpoint. Còn lại là transient.

#### Quyết định engine đáng chú ý

- **Separator là hằng số cứng `__`**, không phải config. Tên server validate bằng
  `/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/` **và** từ chối nếu chứa `__`. Cắt tên lộ ra tại dấu `__` **đầu tiên**.
  mcphub chỉ *cảnh báo* về tên server (`:1710`) với separator cấu hình được (`config/index.ts:256`) — hai server có thể alias vào nhau.
- **Override per-item lưu theo tên upstream TRẦN**, normalize lúc ghi. Core tra đúng một lần.
  mcphub lưu chưa normalize nên phải tra cả khoá trần lẫn khoá có prefix ở mọi nơi.
- **Core phục vụ ngay, không có cổng boot.** `listTools` trả những gì `ready` và báo cáo phần còn lại trong `status()`.
  Call vào server đang `connecting`/`retrying` thì `await ensureReady(deadlineMs)` chứ không fail.
  Server `ready` mà transport rớt vẫn phục vụ catalog cache với `stale: true` trong lúc reconnect.
  mcphub đăng ký route MCP **sau khi** `initUpstreamServers()` resolve — trước đó endpoint 404.
- **Retry đúng một lần, và CHỈ khi chứng minh được request chưa tới upstream** (transport đóng /
  chưa connect / lỗi socket trước byte response đầu tiên). Call đã giao mà trả lỗi — bất kỳ HTTP status nào có response,
  bất kỳ JSON-RPC error nào, bất kỳ `isError: true` nào — **không bao giờ** retry.
- **Không có bypass SSRF theo chủ sở hữu.** Escape hatch là cờ per-server `allowPrivateNetwork: true`, hiện trên UI,
  log mỗi lần connect. mcphub bypass cho server do admin tạo (`:1382-1396`) — mà config server do admin tạo
  vẫn chịu ảnh hưởng từ marketplace.
- **stdio spawn với `shell:false`, `detached:true`**; teardown `process.kill(-pid,'SIGTERM')` rồi `SIGKILL` sau 5s.
  Không `tree-kill`, không `procps` trong image.
- **Credential per-user v1 chỉ cho server REMOTE** (streamable-http / sse), là instance `UpstreamServer` riêng
  khoá `name#userId`, start lười, evict sau 10 phút nhàn rỗi. **Catalog luôn discover bằng credential admin** —
  credential per-user ảnh hưởng thực thi, không ảnh hưởng danh sách tool.
  `credentialMode:'per-user'` mà `principal.credentials === undefined` thì **FAIL**, không fallback sang credential chung.

### 4.2 Rìa downstream — `packages/server`

Bảng route đầy đủ. Đây là artifact — file test route sinh được từ bảng này nguyên văn.

```
# Mọi path tương đối với path component của PUBLIC_URL.
# Slug: ^[a-z0-9][a-z0-9-]{0,63}$ (zod). Không wildcard, không UUID, không sigil '$', không prefix /:user.

METHOD  PATH                                         TARGET                       AUTH
POST    /mcp                                         {kind:'all'}                 bearer
POST    /mcp/g/:group                                {kind:'group', slug}         bearer
POST    /mcp/s/:server                               {kind:'server', slug}        bearer
POST    /mcp/smart                                   {kind:'smart'}               bearer
POST    /mcp/smart/g/:group                          {kind:'smart', groupSlug}    bearer
GET     /mcp, /mcp/*                                 405 + Allow: POST            bearer
DELETE  /mcp, /mcp/*                                 405 + Allow: POST            bearer
ALL     /mcp/* (không khớp trên)                      404 {"error":"not_found"}    bearer

GET     /.well-known/oauth-protected-resource        RFC 9728 PRM doc             public
GET     /.well-known/oauth-protected-resource/mcp/*  cùng PRM doc                 public
GET     /.well-known/oauth-authorization-server      better-auth (RFC 8414)       public
ALL     /api/auth/*                                  better-auth handler          public

# KHÔNG phục vụ: /sse, /messages (transport 2-endpoint deprecated)
#                /:user/mcp/**  (danh tính đến từ credential, không đến từ URL)
#                /api/tools/:server/:tool  (không có REST tool-exec facade ở v1)
```

**Thứ tự check cố định và test được**:
`authenticate` → `gateway.resolveTarget(principal, target)` (null → `404`) →
`checkGrant(grant, scope)` (fail → `403` + `WWW-Authenticate: Bearer error="insufficient_scope"`) → handle.

Group không tồn tại và group principal không thấy được trả về **404 byte-identical**.

**Era adapter là đúng một file**: `packages/server/src/mcp/legacy.ts`. Mọi thứ đặc thù era sống ở đó.
Dùng transport Web-Standard của SDK (`server/webStandardStreamableHttp.js`) với `sessionIdGenerator: undefined`,
**`enableJsonResponse: true`** và header `X-Accel-Buffering: no`. Ta viết **zero** dòng transport.

> **Ba ràng buộc đã đo (§14.3), thiếu cái nào cũng hỏng:**
> 1. **Transport stateless DÙNG MỘT LẦN** — throw ở `handleRequest` thứ hai, mà POST `notifications/initialized`
>    đã là request thứ 2, nên nó giết cú bắt tay của **một** client. Dựng `Server` **và** transport **mới bên trong mỗi request**.
> 2. **Gateway tự trả 405 cho GET** — transport **không** 405; ở chế độ stateless nó trả `200 text/event-stream`
>    và **treo vô hạn**. `app.post('/mcp', …)` cho transport, `app.all('/mcp', …)` anh em trả 405.
> 3. **`enableJsonResponse: true`**, không phải `false` như thiết kế gốc — đó là chế độ **duy nhất**
>    đóng được transport sau `handleRequest`.

**Full-containment là hàm thuần** `checkGrant(grant, scope): 'ok' | 'insufficient'` trong `grant.ts`,
không I/O, có test bảng chân trị vét cạn. Grant theo server vào route group chỉ pass nếu **mọi** thành viên
`scope.serverIds` nằm trong grant.

> `checkGrant` phụ thuộc vào việc `ResolvedScope.serverIds` được core **mở rộng đầy đủ**.
> Nếu core từng trả danh sách lười hoặc một phần, luật full-containment âm thầm suy biến thành partial-containment —
> đúng lớp lỗi GHSA-454m-4vm6-842f. `ResolvedScope.serverIds` được ghi là *complete-or-throw*, kèm test ở core.

**Giới hạn, tất cả ở rìa HTTP**: Hono `bodyLimit` 4 MB · semaphore concurrency per-principal
(mặc định 8, vượt → `429` + `Retry-After: 1`) · deadline per-call qua
`AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(MCP_CALL_TIMEOUT_MS)])` ·
trần kết quả 1 MB serialized kèm marker `[mcprouter:truncated N bytes]`.
Rate limit per-key là của better-auth apiKey plugin, không phải của ta.

---

## 5. Danh tính và phân quyền

### 5.1 Ba loại credential, một verifier

| Loại | Cơ chế | Dùng cho |
|---|---|---|
| Session cookie | better-auth core (email+password, GitHub, Google, genericOAuth OIDC) | Con người dùng console |
| API key `mcpr_…` | better-auth **`apiKey` plugin** | Máy: MCP client, CLI, script |
| OAuth token | better-auth **`mcp` plugin** (OAuth 2.1 AS) | MCP client cần OAuth (Claude.ai, Cursor) |

Plugin lo: sinh key, hash, expiry + tự dọn, rate limit, quota, PKCE, metadata RFC 8414/9728, DPoP,
verify stateless. **Ta không viết dòng nào về lưu password, token hay key.**

Ta chỉ viết: mã hoá Grant, phép giao scope, chokepoint, và route tạo key có cưỡng chế subset.

**Bỏ JWT. Bỏ guest/`skipAuth`. Bỏ token trong query string.** Mọi request mang cookie hoặc `Authorization: Bearer`.
mcphub đọc JWT từ `?token=` (`auth.ts:178-180`) và sinh JWT secret ngẫu nhiên mỗi process khi không set
(`config/jwt.ts:4-14`) — cái sau âm thầm làm hỏng multi-replica.

### 5.2 API key KHÔNG BAO GIỜ ngụ ý admin

Cưỡng chế bằng **hai sự thật cấu trúc**, không phải bằng một phép kiểm tra:

1. **`enableSessionForAPIKeys: false`** trong config apiKey plugin — tên thật, **cực đảo** so với thiết kế ban đầu,
   và giá trị an toàn **đã là mặc định** (§14.2). Bật lên thì plugin mint một session giả cho key, và nhánh
   session→admin của ta sẽ trao quyền admin đầy đủ cho key của một admin.
   Viết tường minh làm **dây bẫy**: tên sai **fail trong im lặng**, không validate, không reject —
   `disableSessionForAPIKeys` (tên trong thiết kế gốc) vẫn mint session đầy đủ và **không có lỗi lúc chạy nào bắt được**.
2. `admin: false` là **literal type** ở nhánh machine của union `Principal`.
   `{via:'apikey', admin:true}` là **lỗi biên dịch**. Không có kiểm tra runtime nào để quên.

Thêm: endpoint client-facing `/api/auth/api-key/*` của plugin bị **404 hoá**, key chỉ mint được qua `POST /api/keys`,
route này verify grant yêu cầu là **tập con** của tập creator với tới được. `enableMetadata: true` khiến metadata
ghi được bởi chủ key qua chính endpoint của plugin — không chặn là member tự cấp cho mình `{scope:{kind:'all'}}`.

~~`metadata.grant`~~ → **`permissions`**. Grant được zod-parse **mỗi lần đọc**, fail-closed về deny.

> **Đảo ngược sau spike 5 (§14.2).** Thiết kế ban đầu để grant trong `metadata`. Đã đo: với `enableMetadata: true`,
> **chính chủ key ghi được metadata tuỳ ý** qua `POST /api/auth/api-key/create` và `/update` chỉ bằng session cookie
> của họ — set `{role:"admin"}` rồi update lại, cả hai **HTTP 200**. `permissions` thì canh bằng
> `SERVER_ONLY_PROPERTY` và **reject 400** trên cả hai route client-facing.
> Grant đi vào `permissions`. `metadata` là input không tin cậy. Giữ `enableMetadata: false`.

### 5.3 Phân quyền: MỘT trục

> **Quyết định của chủ dự án, 2026-09-19.** Hai agent đề xuất hai mô hình loại trừ nhau. Chốt: một trục.

- Con người có **ba role toàn cục**: `viewer` / `operator` / `admin`, check ở middleware theo nhóm route.
- Server và group là **tài nguyên dùng chung toàn team**. **Không** `owner_id`, **không** `visibility`,
  **không** bảng share, **không** predicate `visibleTo`.
- Mọi phạm vi hẹp hơn sống trên **API key** (`grant`: `all | groups[] | servers[]`).
- Role ánh xạ sang một tập permission cố định, khai báo ở một chỗ. `viewer` đọc; `operator` thêm/sửa server, group, key của chính mình; `admin` thêm user, system setting, policy key, và permission **riêng** `audit:payload:read`.
- Riêng tư cá nhân giải quyết bằng **credential binding per-user**: định nghĩa server dùng chung, token riêng từng người.

Điều này xoá thẳng cái vùng mcphub đẻ ra hai đường authz bất đồng (`dataService.ts:6-28` vs `DaoConfigService:171`)
và route mở vì `group.visibility == null` (`utils/groupAccess.ts:6`) — bằng cách làm cho cả hai *không biểu diễn được*.

`role` là `additionalFields` của better-auth với **`input: false`** — không có nó, payload signup set được `role:'admin'`.
User đầu tiên thành admin qua `databaseHooks.user.create.before` đếm số user.

**Vẫn giữ**: `packages/core` không export Drizzle handle thô. Map `exports` chỉ publish `./index.js`,
và `index.ts` export `scoped(p: Principal)` — repository đã nhúng sẵn grant filter.
Endpoint mới **không thể** lấy được handle truy vấn mà chưa có Principal. Kèm một test liệt kê `app.routes`.

> Chokepoint chỉ đứng vững chừng nào `packages/core` còn **một** entry point. Thêm subpath export `./db`
> vì bất cứ lý do gì (test, migration CLI) là mở lại lối vòng. Test liệt kê route **không** bắt được việc đó —
> test "không có raw db handle" mới bắt được.

### 5.4 Secret at rest

Một cặp `seal`/`open` duy nhất, AES-256-GCM, trên một keyring từ env:
`MCPR_SECRET_KEYS=v2:…,v1:…` (phần tử đầu = active). Dùng cho: `env` upstream, `headers` upstream,
client info + token OAuth upstream, credential binding per-user.

AAD là chính các cột: `scope|serverId|userId|label|keyVersion` nối bằng `\x1f`.
Ciphertext copy sang server khác, user khác, slot khác thì **không giải mã được**.
mcphub dùng AAD `[serverName, username]` — đổi tên là hỏng.

CHECK constraint ghim `iv` 12 byte và `tag` 16 byte → bản giả tag bị cắt ngắn **không lưu vào DB được**.

**Thiếu key = từ chối boot**, in ra một dòng đã sinh sẵn để paste. **Không bao giờ tự tạo file key.**
mcphub tự tạo `<settings>.credentials.key` — cùng lớp lỗi phân kỳ âm thầm như JWT secret ngẫu nhiên.

Bảng `secrets` là **kho mã hoá duy nhất trong hệ thống**. `credential_bindings` và `upstream_oauth_tokens`
chỉ giữ metadata và trỏ tới `secrets.id`; `env`/`headers` của server giữ `{"$secret":"<uuid>"}` bên trong
`servers.config`. **Giá trị secret dạng plaintext không biểu diễn được ở bất kỳ cột nào khác.**

**Không có expansion `${VAR}`/`$VAR` từ `process.env`** (mcphub `config/index.ts:150-252`) —
chính cơ chế đó là cách secret kết thúc trong một file config.

### 5.5 OAuth upstream (MCPRouter làm CLIENT)

Khác hẳn việc làm AS — không trộn hai chuyện. Dùng `OAuthClientProvider` của SDK thay vì tự viết lại RFC 9728/8707/PKCE.
Callback yêu cầu session sống mà user khớp với state row phía server; state row **dùng một lần**, TTL 10 phút.
mcphub để `/oauth/callback` public. Đích redirect sau callback là path nội bộ cố định, **không bao giờ** từ query parameter.

---

## 6. Mô hình dữ liệu

12 bảng của ta + 10 bảng better-auth sinh ra, trong **một** chuỗi migration Drizzle với file SQL commit thật.
Bảng better-auth sinh vào `packages/core/src/db/schema/auth.ts` qua `@better-auth/cli generate`, re-export
từ barrel để drizzle-kit thấy.

| Bảng | Vai trò |
|---|---|
| `servers` | ServerConfig (union phân biệt: stdio \| streamable-http \| sse \| openapi) trong jsonb, slug, enabled, credentialMode, allowPrivateNetwork |
| `server_item_override` | enable + description override per tool/prompt/resource, khoá `(server_id, kind, item_name)` theo tên **trần** |
| `groups` + `group_server` | membership + item selection + alias trong một record |
| `secrets` | Kho mã hoá **duy nhất** |
| `credential_bindings` | Slot credential per-user per-server, trỏ `secrets.id` |
| `upstream_oauth_tokens` | Token OAuth upstream; phần **đăng ký** client (CIMD url / DCR client_id) gộp vào `servers.config.oauth` |
| `audit_event` | Nhật ký kiểm toán **duy nhất**: tool call (`evt='tool.call'`), thay đổi config, đọc payload. Không có bảng `call_event` riêng |
| `call_rollup_1m` | Rollup 1 phút cho triage, upsert **cùng transaction** với dòng `audit_event` của call |
| `tool_embedding` | Catalog cache cho tool **và** prompt **và** resource: `input_schema`, `token_cost`, tsvector, vector nullable |
| `catalog_cache` | Response registry theo `path?sortedQuery`, `fetchedAt`, phục vụ stale tới 30 ngày |
| `system_setting` | Cấu hình hệ thống + mutex bootstrap admin |
| `policy_rule` | Luật guardrail, first-match theo `seq`. Xem §11.3 |
| `approval_request` | Hàng đợi duyệt human-in-the-loop, kiêm ticket dùng một lần. Xem §11.5 |

Guardrail còn thêm cột vào `tool_embedding`, `server_item_override` và `servers` — bảng đầy đủ ở **§11.7**,
kèm một cảnh báo vận hành về AAD của `secrets` phải đọc trước khi viết migration.

**Luật cột-vs-jsonb**: một giá trị được cột riêng **khi và chỉ khi** Postgres phải filter, join, order,
hoặc cưỡng chế unique/FK trên nó, **HOẶC** một writer đồng thời có thể sửa nó độc lập với anh em nó.
Còn lại, thứ một chủ sở hữu đọc-ghi như một object nguyên khối thì là jsonb, validate bằng zod
discriminated union ở **biên HTTP** trước khi chạm DB.

**Slug CHECK** `~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'` loại trừ `_`, và separator là hằng `__`.
Hai server **không thể** alias vào namespace tool của nhau.

**`tool_embedding` mang CẢ tsvector VÀ vector nullable.** Lexical không phải fallback hạng hai chắp vá về sau —
nó là **cùng một query, khác `ORDER BY`**, luôn luôn có mặt. Bỏ hẳn hash-fallback 100 chiều vô nghĩa của mcphub
(`vectorSearchService.ts:1029`). Index **HNSW** (`m=16, ef_construction=64, vector_cosine_ops`), không IVFFlat —
IVFFlat cần train trên dữ liệu đại diện, mà catalog của một team thay đổi liên tục và chỉ cỡ hàng trăm đến vài nghìn dòng.

**`audit_event` không partition, KHÔNG foreign key**, và denormalize tên hiển thị của server/group/key/user.
Thu hồi một key hoặc xoá một server **không thể** xoá hay làm trắng dấu vết.
Retention hai tầng: payload bị scrub ở `PAYLOAD_RETENTION_DAYS` (mặc định 7), dòng bị xoá ở
`AUDIT_RETENTION_DAYS` (mặc định 90), cả hai bằng statement batch chạy mỗi giờ.

**Migration** chạy in-process lúc boot dưới `pg_advisory_lock` để nhiều replica tuần tự hoá.
CI chạy `drizzle-kit generate` và fail trên `git diff --exit-code drizzle/`.
`MIGRATE_ON_BOOT=false` + `node dist/migrate.js` cho operator mà role ứng dụng không có quyền DDL.

**Bootstrap admin**: không có credential seed. Token 256-bit in ra boot log, claim bằng
`DELETE ... RETURNING` trên `system_setting` — chính câu lệnh đó là mutex. mcphub ship `admin/admin123`.

---

## 7. Smart Routing và Context Cost

### Smart Routing

**Đúng ba meta-tool, luôn luôn**: `search_tools`, `describe_tool`, `call_tool`.
Progressive Disclosure là **vô điều kiện** — không toggle, không setting, không override per-group.
mcphub biến PD thành cờ toàn cục; nếu PD tốt hơn hẳn thì cái toggle chỉ là một nhánh code thừa cộng một cách cấu hình sai.
`describe_tool` nhận `names: string[]` (1..20), trả nhiều schema trong **một** call.

`call_tool` **đi lại vào chính** `callTool` public với `smart:false`. Meta-tool **không bao giờ** là đường đặc quyền
vòng qua enforcement enable/disable.

Text embed mỗi tool có **tên và mô tả của server prefix vào** — đó chính là thứ nhánh server-embedding
blend `0.8*tool + 0.2*server` của mcphub đang với tới, nhưng bằng một bảng thay vì ba cơ chế song song.

Scope **đẩy vào SQL**, không bao giờ filter sau `LIMIT` — bug `a6f3747` của chính họ.

**Khi KHÔNG cấu hình embedding provider**: cột vector để NULL, `search_tools` xếp hạng thuần bằng tsvector.
Tính năng vẫn chạy, chỉ là lexical thay vì semantic, và UI nói đúng điều đó.
mcphub rơi về hash 100 chiều (`vectorSearchService.ts:1029`) — thứ trông như semantic search nhưng xếp hạng vô nghĩa,
tệ hơn lexical trung thực.

### Context Cost

Là **một số nguyên đã persist**, không phải tính lại mỗi lần. Engine ghi `tool.tokens`
(cl100k của `JSON.stringify({name, description, inputSchema})`) **lúc cache**, cạnh tên đã namespace.
`GET /api/cost` là một `SUM()/GROUP BY`. Thanh đo token sống trong group editor cộng client-side
từ dữ liệu nó đã có sẵn.

mcphub tính lại live mỗi request (`contextCostService.ts:76-95`) và không persist gì.

Báo cáo: **Gross** (mọi item server khai báo) vs **Exposed** (item client thật sự nhận), per server và per group,
cộng Smart Routing footprint — để chỗ tiết kiệm nhìn thấy được.

---

## 8. Observability — điểm khác biệt chính

mcphub có: ring 1000 dòng in-memory qua monkey-patch `console.*`, bảng activity chỉ ở DB mode,
`/health` trả 200 "degraded" khi mọi upstream đang chết. Không `/metrics`, không trace, không request-ID,
không log JSON có cấu trúc, không histogram latency. Docs của họ tự thừa nhận và đẩy sang APM ngoài.

### Một định danh tương quan

`requestId` là một W3C trace-id hợp lệ (32 hex thường). Khi bật OTel, rìa lấy
`trace.getActiveSpan().spanContext().traceId`; khi tắt, `randomBytes(16).toString('hex')`.

Cùng 32 ký tự đó xuất hiện ở: **mọi** dòng log · header `x-request-id` · exemplar của metric ·
cột `audit_event.request_id` · `error.data.requestId` trả về cho MCP client · và một chip mono trên **mọi** dòng UI.

Lan truyền bằng `AsyncLocalStorage` (`node:async_hooks`) do `packages/core/src/obs/context.ts` sở hữu.
**Chỉ dùng `.run()`** — `.enterWith()` bị cấm bởi rule eslint `no-restricted-properties`.
mcphub có fallback `enterWith` (`userContextService.ts:28,38`) có thể rò principal qua ranh giới async.

> Store ALS là **chỉ để observability**. Mọi hàm authz nhận `principal` làm tham số tường minh.
> Một vụ rò ALS **không thể** trở thành lỗi phân quyền.

### Secret không lọt vào log

Bằng **`serializers` của pino trên domain object**, không phải regex scrub.
`serializers.server = redactServerConfig` trả `{name, type, url, command, envKeys: string[], headerKeys: string[]}` —
**chỉ tên khoá, không bao giờ giá trị**. Một dòng `log.info({server: cfg})` bất cẩn vẫn an toàn.

**Tool argument và tool result KHÔNG BAO GIỜ được log ở bất kỳ level nào** — dòng log chỉ nhận
`inBytes`, `outBytes`, `inHash` (sha256, 16 hex đầu).

### Luật cardinality, cưỡng chế cơ học

**Không bao giờ nhân hai chiều cardinality trung bình trong một metric.**

- `tool` chỉ là label trên **counter** (`mcprouter_tool_calls_total{server,tool,outcome}`), **không bao giờ** trên histogram.
- Danh tính caller nằm ở counter **riêng** (`mcprouter_client_calls_total{client,outcome}`), với `client` là
  id key của better-auth — do admin tạo, có biên — **không bao giờ** là `clientInfo.name` do client tự khai.
- Chi tiết per-(tool × client × latency) sống ở **Postgres**.
- Giá trị label `tool` được định kiểu: `recordToolCall(ref: ResolvedTool | null, …)` nhận object tool đã phân giải
  có brand; `ref` null ghi `tool="__unknown__"` — client spam tên tool không tồn tại **không mint được series mới**.

Phân vai cứng: **Prometheus** trả lời *"fleet đang hình gì ngay bây giờ"* với label set có biên chặt.
**Postgres** trả lời *"ai chính xác đã làm gì"* với chiều không giới hạn. Hai cái nối nhau bằng đúng một id đó.
Không histogram per-tool, không bom cardinality, không pipeline log phải vận hành.

### OTel opt-in

Bật **khi và chỉ khi** `OTEL_EXPORTER_OTLP_ENDPOINT` được set. Bootstrap là
`node --import ./otel-bootstrap.mjs dist/index.js` mà dòng đầu tiên là `if (!endpoint) return;`.

**Không** cài `@opentelemetry/auto-instrumentations-node`. Cài đúng ba: `instrumentation-http`,
`instrumentation-pg`, `instrumentation-undici`. **Chỉ trace** — không pipeline metric, không pipeline log của OTel.

`packages/core` phụ thuộc **duy nhất** `@opentelemetry/api` (no-op khi không có SDK);
`@opentelemetry/sdk-node` là dependency của `packages/server`.

### Audit: mặc định `metadata`, không `full`

Ba chế độ: `off` | `metadata` (**MẶC ĐỊNH**) | `full`, đặt toàn cục và override được per-server.

`metadata` lưu **tên khoá** của argument (`input_keys text[]`), số byte và hash — không bao giờ giá trị.
`full` lưu input/output nguyên văn, không scrub heuristic, cap 64 KB mỗi bên.

**Ta ĐỒNG Ý với mcphub rằng regex redactor là tự tin giả.** Ta **KHÔNG đồng ý** để verbatim làm mặc định:
bảng audit verbatim biến thành mục tiêu giá trị nhất trong toàn bộ deployment.

`full` sống được nhờ ba kiểm soát tách biệt: cột payload bị null hoá ở `PAYLOAD_RETENTION_DAYS` (7)
trong khi dòng metadata sống tới `AUDIT_RETENTION_DAYS` (90) · đọc payload cần permission **riêng**
`audit:payload:read` · và **mỗi lần đọc payload tự ghi một dòng audit** (`evt:'audit.payload.read'`).
Call dùng credential binding per-user **luôn luôn** metadata-only, không override được.

Ghi audit **nằm ngoài đường critical của tool call**: queue in-process có biên (cap 10.000),
flush bởi một writer mỗi 250 ms hoặc ở 200 dòng, bằng một INSERT nhiều dòng.
Flush fail thì re-queue một lần; DB chết và queue đầy thì mỗi bản ghi bị đẩy ra **log stream**
ở level `error` với `evt:'audit.spill'` — rơi vào stdout/Docker log thay vì bốc hơi.
SIGTERM kích hoạt flush đồng bộ với ngân sách 5s.

**Đúng hai ngoại lệ ghi đồng bộ**: `approval.decided` và `approval.args.read` (§11.5) ghi **trong cùng
transaction** với UPDATE quyết định — không phải statement thứ hai, không phải connection thứ hai.
Một quyết định chưa bền vững thì không được hành động theo. Ghi ra đây để implementer sau không
định tuyến chúng qua queue và giết bất biến trong im lặng.

> SIGTERM flush. SIGKILL và OOM **không**. Với deployment cần tuân thủ compliance, đây là đánh đổi sai,
> và đường nâng cấp (insert đồng bộ, hoặc spool trên đĩa) là một thay đổi thật, không phải một cờ.

### Ba mặt health, ba hợp đồng khác nhau

| Endpoint | Auth | Hợp đồng |
|---|---|---|
| `GET /health/live` | public | 200 khi và chỉ khi event loop còn chạy. **Không bao giờ** chạm dependency — giết container không sửa được Postgres |
| `GET /health/ready` | public | 200 chỉ khi migration đã apply, `SELECT 1` xong trong 2s, pass reconcile upstream đầu tiên đã xong, route MCP đã mount. Ngược lại 503 với boolean từng check, **không** tên server, **không** chuỗi version |
| `GET /api/health` | authed | Luôn 200. Là **BÁO CÁO**, không phải probe: state từng server, `since`, `lastError`, `lastSuccessAt`, p95, error rate 5 phút |

**Tình trạng upstream MCP server cố ý KHÔNG nằm trong readiness probe.**
Từ "degraded" chỉ tồn tại trong báo cáo fleet, **không bao giờ** trong status code của một probe.
mcphub trả 200 "degraded" khi server chết (`healthController.ts:32-46`) — một hub hỏng vẫn qua được probe ngây thơ.

### Câu hỏi tầng này phải trả lời trong một màn hình

> *"Upstream nào đang chậm hoặc đang hỏng ngay lúc này, và client nào đang gây ra?"*

Màn `/triage`, chống lưng bởi hai câu SQL: một trên `audit_event WHERE evt='tool.call'` (cửa sổ live 15 phút, p95 thật)
và một trên `call_rollup_1m` (baseline 24h, sparkline).

---

## 9. Console vận hành

### 9.1 Design system

**Một file CSS.** 21 primitive shadcn/ui stock. 6 component bespoke.

**Ý tưởng cốt lõi**: mọi màu là một semantic token tự hoán đổi, nên **variant `dark:` bị cấm trong code ứng dụng**
(lỗi ESLint). 284 dòng `!important` và 1000+ utility `text-gray-700` của mcphub tồn tại chính vì nó có
`--hub-*` token cho một số thứ và màu palette Tailwind cho phần còn lại, rồi phải retrofit phần chênh lệch.

`@theme inline` định nghĩa **cả** 16 token của ta **và** alias mọi tên shadcn phát ra
(`--color-card`, `--color-muted-foreground`, `--color-ring`, …) lên chúng.
Lỗi class không định nghĩa ở mcphub `LogViewer.tsx:70,148,160` trở thành **không thể xảy ra về mặt cấu trúc**,
và một vitest 40 dòng chứng minh điều đó mỗi lần build.

`:root` giữ giá trị **DARK**; light là `[data-theme="light"]`. Không có script theme-boot inline trong `index.html` —
dark là mặc định của cascade nên không cần JavaScript.

#### Contrast ledger — đo thật, không ước lượng

```
DARK                                   LIGHT
token        hex      min   AA-text     hex      min   AA-text
──────────────────────────────────────────────────────────────
ink-1        #f4f5f7  14.87  PASS       #171b1f  15.18  PASS
ink-2        #bbbec1   8.69  PASS       #484e54   7.41  PASS
ink-3        #8d9196   5.12  PASS       #5d646b   5.26  PASS
brand        #57c3cf   7.84  PASS       #01729f   4.74  PASS
ok           #61d688   8.90  PASS       #1a763f   4.97  PASS
warn         #f6bd48   9.49  PASS       #8b5e22   4.93  PASS
err          #fb7475   6.08  PASS       #c2272d   5.11  PASS
idle         #8e9398   5.22  PASS       #5f6469   5.26  PASS
busy         #8fadee   7.24  PASS       #385db8   5.41  PASS
line-strong  #6c7278   3.35  PASS(3:1)  #82878c   3.19  PASS(3:1)
line         #2a2e32   1.19  decorative #dbdee1   1.18  decorative

FOCUS RING (brand, offset lên layer cha):
  dark  9.45 vs bg · 8.78 vs raised · 7.84 vs surface  -> PASS 3:1
  light 5.17 vs bg · 5.40 vs raised · 4.74 vs sunken   -> PASS 3:1
```

Tỉ lệ đo với **cả bốn** layer nền; cột hiển thị là **tối thiểu**. Tính bằng
oklch→OKLab→linear sRGB→relative luminance→`(L1+0.05)/(L2+0.05)`.

**Năm giá trị trượt ở lượt đầu và đã bị sửa:**

1. `brand` dark `oklch(0.76 0.135 205)` và `busy` dark `oklch(0.75 0.13 265)` **ngoài gamut sRGB** —
   browser clamp thành `#00c9da`/`#85acff`, tức màu ship ra **không phải** màu đã đặc tả.
   Cắt chroma `0.135→0.100` và `0.13→0.100`. Cùng cách sửa cho `warn` light và `brand` light.
2. `idle` dark ở L 0.62 đo được **4.46:1** trên `--surface` — trượt AA text đúng 0.04. Nâng lên L 0.66 → 5.22.
3. `idle` light ở L 0.55 đo 4.25 trên `--sunken` — trượt. Tối xuống L 0.50 → 5.26.
4. `--line-strong` ở L 0.42/0.80 đo 2.15–2.31 và 1.79–1.87 — **trượt luật 3:1 cho viền control tương tác**
   (WCAG 1.4.11). Chuyển sang L 0.55/0.62 → 3.35/3.19.
5. Tránh lỗi neon kinh điển bằng cách **không đi neon**: `ok` ở L 0.79 thay vì xanh phosphor L 0.88
   (chỉ mất contrast không đáng kể nhưng đọc ra như đồ chơi), và `err` được **làm sáng** lên L 0.72 thay vì
   giữ đỏ bão hoà tầm trung — đỏ tầm trung qua được 4.5:1 trên `#0a0c0f` rồi **trượt** trên `#1e2124`,
   nơi phần lớn chữ `err` thật sự nằm.

**Không trạng thái nào báo hiệu bằng hue đơn thuần.** `<StatusDot>` mang một glyph riêng cho mỗi state,
và mọi status trong bảng đều đi kèm chữ.

#### Luật định danh

Tên tool, tên server, URL endpoint, id, số token: **luôn** mono + tabular numerals.
Cưỡng chế bằng **một** component `<Id kind=…>` cộng **một** rule ESLint local 22 dòng
`mcprouter/no-bare-identifier`. Không phải bằng kỷ luật review.

#### Khác

- Font: **Geist Sans + Geist Mono self-host** từ package `geist` 1.7.2 đã pin, hai file variable woff2,
  `font-display: optional` + `<link rel=preload>`. mcphub khai `Geist Mono/JetBrains Mono` nhưng **không bundle** —
  rơi về system mono.
- **Inspector là một URL search param** (`?inspect=server:github`). Xếp chồng modal là **không thể về mặt cấu trúc**.
  Chỉ `alert-dialog` được layer lên trên, chỉ cho confirm phá huỷ.
- **Nav rail và cmdk palette render từ CÙNG một mảng `registry.ts`.** Route không có trong mảng thì
  không có trong nav và không có trong palette.
- **Không cài shadcn `scroll-area`** — style scrollbar native trong `@layer base`.

### 9.2 Màn hình và tầng dữ liệu

15 màn hình routed trên một REST projection mỏng, **một** kênh SSE, và TanStack Query là cache client **duy nhất**.

**Console không bao giờ poll và không bao giờ giữ state riêng.**

#### Một kênh SSE

`GET /api/events?topics=&server=&level=`, auth **chỉ** bằng session cookie của better-auth
(`HttpOnly; Secure; SameSite=Lax`). **Không token trong bất kỳ URL nào** — mcphub nhét JWT vào
query string của `/logs/stream` (`services/logService.ts:82`).

Consumer dùng API key **không có SSE**; họ poll `GET /api/logs?since=` và `GET /api/activity?before=`
với `Authorization: Bearer`. CLI **phải** tôn trọng hợp đồng này.

**Một luật nhất quán cache, không ngoại lệ:**

| Frame | Hành động |
|---|---|
| `status`, `sync` | **PATCH** cache qua `setQueryData` |
| `changed`, `call` | **INVALIDATE** với `refetchType:'active'` |
| `log` | **Không bao giờ** chạm Query |

Xoá bỏ: 5 provider lồng nhau của mcphub, `SettingsContext` 1202 dòng, poller 3s×60-rồi-30s
(`ServerContext:28-38`), và cái fetch interceptor có listener click toàn cục trên `document`.

> Frame `status` là một **hợp đồng**: nó phải mang **đủ** tập field nó sở hữu
> (`state`, `toolsExposed`, `toolsGross`, `lastError`, `since`). Một thay đổi ở engine phát ra frame thiếu field
> sẽ âm thầm làm lệch dòng fleet mà **không có lỗi ở đâu cả**.

#### Settings sinh từ một zod schema

Một schema zod 4 annotate qua `z.registry<SettingMeta>()`. Cùng schema đó: validate `PATCH /api/settings`
ở server, và khi đi bộ trên client thì sinh ra form từng section routed, index tìm kiếm, và entry cmdk.

Route `/settings/:section#<dotted.path>`. Dirty state là object diff so với giá trị đã fetch.
Rời trang dùng `useBlocker` của react-router.

Thay cho accordion 3928 dòng không search, không deep-link.

> Áp lực thêm `control: 'tree' | 'matrix' | …` vào từ vựng meta sẽ dựng lại chính cái accordion 3928 dòng
> **bên trong** một schema. Escape hatch phải giữ là một component tuỳ biến thường, khoá theo path.

#### Hai luồng nặng ký nhất

**Thêm server** — wizard 3 bước routed (`/servers/new?step=source|configure|verify`),
**không persist gì** cho tới Verify→Save. Bước 3 chạy probe phù du (`POST /api/servers/probe`, TTL 30s)
mà log connect của nó stream trên **cùng kênh SSE** dưới `server: "probe:<id>"`.
mcphub làm việc này trong một modal 2300 dòng.

**Group editor** — hai pane (không phải wizard), với action **"Preview as client"** render đúng
payload `tools/list` mà group đó sẽ trả về, đã áp dụng thay thế alias.

#### Tool explorer

Console invoke qua `POST /api/tools/:server/:tool/invoke`, chạy **đúng** đường call của core như một MCP request thật —
**bao gồm cả check enable lúc gọi** — và ghi một dòng `audit_event` với `principal_kind='console'`.

---

## 10. Marketplace, install, OpenAPI

**Đúng MỘT nguồn catalog**: `registry.modelcontextprotocol.io/v0`, base URL override được qua
`MCP_REGISTRY_URL` cho team chạy registry riêng/mirror. Không file catalog bundle, không catalog cloud của vendor.
mcphub mang ba nguồn, ba code path, ba tab UI, một nguồn có ích.

Cache mọi response vào Postgres theo `path?sortedQuery`, tươi 15 phút, phục vụ **stale tới 30 ngày**
khi upstream chết, gắn cờ `stale:true` + `fetchedAt` để UI hiện badge "cached".
Prune dòng quá 30 ngày trong **cùng** statement ghi.

**Entry của registry CHÍNH LÀ schema của form install.** `planInstall(entry, variantKey?)` biên dịch
`packages[].environmentVariables/packageArguments/runtimeArguments` và `remotes[].headers` thành
`InstallInput[]` phẳng mà UI render tổng quát. Plan và render **stateless** — không plan token,
không wizard state phía server.

**Thứ tự ưu tiên variant**: `remote` (streamable-http, rồi sse) > `npm` > `pypi` > `oci` > `nuget`.
Variant được yêu cầu tường minh **không bao giờ** bị thay thế — không hỗ trợ thì trả lý do và từ chối,
không âm thầm fallback (luật này của mcphub đúng, sao chép nguyên văn).
Version **pin chính xác** từ entry (`npx -y pkg@1.2.3`), không bao giờ `@latest`.
`runtimeHint` check với allowlist `{npx, uvx, docker, dnx, node, python, python3}` — đây là **biên tin cậy**:
không có nó, một entry registry đặt tên được `/bin/sh`.

**Một `probe(config)` trong core phục vụ BA tính năng**: dry-run catalog, preview OpenAPI trước khi save,
và "test connection" ở trang Servers. Không persist gì, và khi fail thì **không** secret nào caller gửi lên
được ghi ở đâu cả.

**Secret từ form install đi thẳng vào `putSecret()`**; `ServerConfig` persist chỉ mang `{"$secret":"<uuid>"}`.
Thiếu secret **bắt buộc** là 400 cứng liệt kê mọi tên thiếu, **trước khi** ghi bất kỳ dòng nào và
**trước khi** thử connect.

### OpenAPI bridge là MCP server in-process THẬT

`createOpenApiTransport(cfg)` dựng một `Server` low-level của SDK với handler `tools/list` + `tools/call`,
nối bằng `InMemoryTransport.createLinkedPair()`, trả về nửa client dưới dạng một `Transport` thường.
Transport factory của core thêm **đúng một nhánh**.

Hệ quả: namespace, filter lúc gọi, cost accounting, audit logging **áp dụng miễn phí**.
Hai khối code ~150 dòng gần như trùng nhau của mcphub (`mcpService.ts:3741` và `:3944`) **không bao giờ ra đời**.

**KHÔNG dereference spec.** Giữ nguyên `$ref`, rewrite `#/components/schemas/X` → `#/$defs/X`,
và gắn vào inputSchema của mỗi tool **chỉ** những `$defs` với tới được bắc cầu từ operation đó.
Xoá luôn `@apidevtools/swagger-parser`, xoá resolution `$ref` ngoài, xoá code xử lý ref vòng —
và bịt một lỗ SSRF external-`$ref` trong cùng một nhát.

**Hai biên SSRF, cả hai tường minh**: (1) fetch spec — `safeFetch` + `redirect:'manual'`,
`assertSafeUrl` trên mỗi `Location`, tối đa 3 hop, cap 5 MB. (2) **mọi** call upstream —
percent-encode mọi path param, rồi assert `new URL(final).origin === new URL(baseUrl).origin`
trước khi fetch, và validate lại mọi redirect `Location` y như vậy.

Operation dùng tính năng không hỗ trợ (`deepObject`/`spaceDelimited`/`pipeDelimited`/`matrix`/`label`,
body multipart-only, `$ref` ngoài không giải được) bị **SKIP** với lý do đọc được bằng máy,
hiện trong preview dưới dạng danh sách `skipped[]` **cạnh** số tool và token cost — không giấu sau disclosure.

**Không ship** `.mcpb` upload ở v1. **Không ship** `/.well-known/mcp-marketplace` — không có surface
unauthenticated nào trong subsystem này.

---

## 11. MCP Guardrails

Gateway ngồi đúng chỗ để làm việc này: **mọi** định nghĩa tool và **mọi** tool call chảy qua nó.
mcphub không có gì ở mảng này. Spec MCP nói thẳng hai điều làm nền: *"Tools represent arbitrary code execution"*
và *"descriptions of tool behavior such as annotations should be considered **untrusted**, unless obtained from a trusted server"*.

Bốn cơ chế. Mỗi cơ chế ghi rõ nó **chặn** hay chỉ **báo cáo**, và cơ chế nào là thật cơ chế nào là diễn.

> Mục này là bản **đã hoà giải sau critique đối kháng**. Hai bản thiết kế gốc đều nhận verdict
> `needs-revision` với tổng 25 lỗ bảo mật (2 CRITICAL). Nguyên liệu: `docs/superpowers/designs/guardrails-*.json`.
> Chỗ nào mục này khác bản gốc, mục này thắng.

### 11.1 Nguyên tắc bất đối xứng — quyết định mọi câu hỏi về bề mặt lỗi

| | Kẻ địch là ai | Client được biết gì |
|---|---|---|
| **Integrity** (rug-pull) | **Upstream server** | **Không gì cả.** Byte-identical `Tool not found: ${name}` |
| **Policy / approval / egress** | **Không ai** — caller là principal hợp lệ, đã qua grant và group | Đúng những gì operator chọn nói |

Với integrity, một lỗi phân biệt được kiểu *"quarantined pending review"* nói cho kẻ tấn công biết tool tồn tại,
rằng ta đã phát hiện, và khi nào nên dừng — tệ hơn, nó **biến model đang gọi thành luật sư của kẻ tấn công**
(*"nhờ admin duyệt tool X giúp"*). Với policy thì ngược lại: kết quả có ích là model **dừng vòng lặp retry**
và nói cho con người biết vì sao.

### 11.2 Chống rug-pull — cơ chế duy nhất không có bài toán false positive

Đòn tấn công thật: server được duyệt lúc lành, rồi âm thầm đổi `description` hoặc `inputSchema` để lái model.
So khớp hash là **exact**, không heuristic. Không có "có vẻ độc hại".

**Integrity không phải state machine phải điều khiển — nó là một phép so sánh.**
`approved_hash === def_hash`, thêm **một** vế AND vào `isExposed` đã có sẵn. Server đột biến một tool lúc 03:00
bị quarantine **bằng số học** ngay khoảnh khắc hash mới ghi xuống. Không watcher, không background job, không transition code.
Trạng thái `changed` được **suy ra** (`review_state='approved' AND approved_hash <> def_hash`), **không bao giờ lưu**,
nên nó không thể cũ.

Phân vai ghi: **engine ghi sự thật** (`tool_embedding.def_hash`), **operator ghi ý kiến**
(`server_item_override.review_state / approved_hash / approved_def`).

#### Hash cái gì — đây là chỗ bản gốc sai CRITICAL

Bản gốc hash một **allowlist** field. Mọi thứ ngoài danh sách nằm ngoài hash: `_meta`, `icons`,
field `2025-11-25` nào bị quên, vendor extension, `size` của resource. Nhiều client đưa `_meta` và `icons`
tới model. Đòn bypass: được duyệt với description sạch, rồi **dời payload sang trái một key vào `_meta`**.
`def_hash` không nhúc nhích, `isExposed` vẫn true, không frame `changed`, không dòng queue.
**Toàn bộ guard bị vô hiệu.**

**Đảo ngược**: hash **nguyên object như đã nhận** (`canonical(def)`), và suy ra shape hash bằng cách
**XOÁ** các key prose, không phải liệt kê key shape. Bao trùm field lạ theo cấu trúc, **ít dòng hơn** allowlist,
và một field spec mới sẽ trip hash đúng một lần rồi được review — **đúng hướng fail**.

```ts
// packages/core/src/guardrails/hash.ts
// ponytail: determinism-only, NOT RFC 8785. Ta chỉ so hash của ta với hash của ta.
//           Đổi sang canonicalize@2 nếu hash từng vượt ranh giới process ta không sở hữu.
const PROSE_KEYS = ['description', 'title', 'annotations'] as const;

canonical(v)   // đệ quy sort key + JSON.stringify. NFC chỉ áp lên string VALUE, KHÔNG áp lên key.
               // NFKC bị từ chối: nó fold ligature và full-width form — thứ ĐỔI cách render,
               // và là vector che giấu đã biết. Key để nguyên nên property name homoglyph
               // là một thay đổi, không phải một phép fold.
defHash(def)   = sha256hex(canonical(def))                       // NGUYÊN object
shapeHash(def) = sha256hex(canonical(omit(def, PROSE_KEYS)))     // suy ra bằng cách XOÁ
```

#### Chính sách lần đầu — TOFU gấp vào bước xác nhận cài đặt

Block-by-default và TOFU **hội tụ** nếu nhận ra: lúc cài đặt, người review **đã có mặt**, đang nhìn màn hình.
Luồng Add-Server discover catalog bằng credential admin **trước khi** enable, nên bước cuối render mọi tool
kèm token cost và annotation — và **"Enable server" CHÍNH LÀ cú click duyệt**.

- Item trên server **chưa từng enable lần nào**: ghi `approved`, `approved_hash = def_hash`,
  `approved_by = <principal đang enable>`, trong **cùng transaction** với `servers.enabled = true`.
- Item xuất hiện **sau đó** trên server đã enable: `unreviewed`.

> **Lỗ HIGH đã vá.** Bản gốc gác TOFU bằng *"server chưa từng enable"* mà **không có gì lưu điều đó**.
> Implement tự nhiên sẽ test `servers.enabled === false` → **tắt rồi bật lại là rửa sạch quarantine đang sống**.
> Operator thấy `github: 3 changes pending review` chắc chắn sẽ thử tắt-bật để "sửa".
> Vá: cột **`servers.first_enabled_at timestamptz`** (tương đương: chỉ chạy TOFU khi **zero** dòng override
> tồn tại cho server đó). **Re-enable KHÔNG BAO GIỜ duyệt bất cứ thứ gì.** Test bất biến P2:
> quarantine sống sót qua một chu kỳ disable/enable.

Setting: `guardrails.integrity: 'enforce' | 'observe' | 'off'` (mặc định **`enforce`** — guardrail ship ở trạng thái tắt là diễn)
và `guardrails.newItemsOnEnabledServer: 'quarantine' | 'approve'` (mặc định `quarantine`).
`observe` tồn tại để một team roll out mà không làm gãy agent ngay ngày đầu.

> Bật `integrity` từ `off`/`observe` sang `enforce` **giấu cả catalog cùng lúc** — mọi thứ discover
> trong lúc tắt đều là `unreviewed`. Control trong Settings phải **tính và hiện con số trước khi save**:
> *"42 item trên 6 server sẽ bị ẩn — review ngay / duyệt hết / huỷ"*. Mười dòng code, và là khác biệt
> giữa một lần roll-out và một sự cố.

#### Bảng sparse — chỗ fail open dễ vấp nhất

`server_item_override` là bảng **override**, tức **sparse**. Item discover sau khi enable **không có dòng**.
Không viết rõ default thì implementer sẽ mặc định `review='approved'` cho khớp với `enabled=true` mặc định
của chính bảng đó → **fail open đúng vào case tính năng này sinh ra để bắt**.

**Viết rõ và test**: thiếu dòng nghĩa là `{enabled: true, review: 'unreviewed', approvedHash: null}`.
`LEFT JOIN` + `COALESCE(review_state, 'unreviewed')`. Dòng chỉ được tạo ra bởi hành động của operator
hoặc TOFU lúc enable, nên bảng vẫn sparse.

#### Cap trên response upstream — chính đường validate là bộ khuếch đại

`bodyLimit` 4 MB là của **POST downstream**. Cap per-item áp **sau khi** chuỗi canonical đã dựng xong.
Upstream độc hại hoặc hỏng trả `tools/list` 500 MB, hoặc 50.000 tool mỗi cái 200 KiB — từng cái dưới mọi cap —
**OOM process đơn**.

Cap **trước khi parse**: bộ đếm byte trên fetch stream (HTTP) và độ dài dòng tối đa (stdio),
cộng số item tối đa mỗi kind (~2.000). Vượt bất kỳ cái nào thì **SERVER** vào `failed` kèm lý do,
**không phải** item vào `defect`. Đây là validate ở biên tin cậy — nấc thang ponytail không áp dụng.

#### Quarantine trông như thế nào

Item `quarantined` / `rejected` / `defective` / `disabled` **byte-identical** với item không tồn tại:
`isExposed` trả false, `resolveTool` ném đúng `Tool not found: ${name}` từ **đúng một chỗ dựng** đã có sẵn.
Không thêm message "pending review".

Emit `notifications/tools/list_changed` ở **cả hai chiều** — quarantine **và** un-quarantine — để client
tuân thủ re-list. Bản gốc chỉ emit chiều quarantine, nên sau khi duyệt client vẫn giữ danh sách thiếu item.

#### Chỗ thiếu quan trọng nhất: chặn vì integrity phải được audit và đếm

Critique gọi đây là *"yếu tố quyết định duy nhất xem tính năng này sống qua tháng đầu không"*.
Policy deny ghi audit row. Call chết vì quarantine ghi **không gì cả** và trả lỗi cố tình mờ đục.
Không operator nào trả lời được *"guardrail này có đang làm hỏng agent của tôi ngay lúc này không"* —
đúng câu hỏi quyết định giữ bật hay tắt.

Lý lẽ "lộ oracle" **không áp dụng**: audit row **nội bộ** không rò gì cho client.
Ship: dòng `audit_event` cho mọi lần chặn vì integrity, cộng `mcprouter_integrity_block_total{reason}`.

#### Diff mà operator review là một biên tin cậy — cho MẮT người

Render `<pre>`-escaped, **không bao giờ** markdown. Bidi control (U+202A–202E, U+2066–2069) và
ký tự zero-width render **literal**. Whitespace hiện rõ. Dòng dài clamp.
Gần như ai cũng quên case bidi, và nó **đánh bại hoàn toàn** việc review.

Lưu **`approved_def jsonb`** trên dòng override lúc duyệt — không có nó thì pane diff ở P3 không dựng được,
và câu hỏi hậu sự cố *"ta đã thật sự chúc phúc cho cái gì"* không trả lời được. Cái này **thay thế**
cột `schema_hash` của bản gốc (chip `desc | schema` trở thành so sánh tại chỗ trên dữ liệu đã join).

TOCTOU-safe: operator submit `defHash` mà họ **đã được xem**, UPDATE là `WHERE def_hash = $seen`,
0 dòng → `409` + diff mới. Áp cùng kiểu **optimistic concurrency cho reorder rule** (bản gốc quên,
hai admin reorder đồng thời tạo ra thứ tự không ai chọn — mà first-match order **chính là** ngữ nghĩa).

#### Giới hạn đã ghi rõ, không sơn phết

- Catalog phân kỳ theo credential per-user: **không hash nào phát hiện được**.
- **Nội dung** resource: ngoài phạm vi. Chỉ định nghĩa được hash.
- Định nghĩa ổn định mà **hành vi** đổi: không phủ.
- Mệt mỏi khi review: **không giải được bằng kỹ thuật**.

`servers.trust = 'trusted'` chỉ **đẩy tiếp một approval ĐÃ CÓ cho một item tên không đổi**.
Một tên **chưa từng thấy** luôn đi theo `newItemsOnEnabledServer`. Không viết bất biến này ra thì
đòn rename-để-né-policy hạ cánh: server trusted thêm `write_file_v2`, được auto-approve, lộ ra,
và mọi rule `deny … write_file` trượt. **Integrity là thứ duy nhất chặn được rename phá rule theo tên.**

### 11.3 Policy engine — luật là dòng trong bảng, không phải ngôn ngữ

**Policy không phải một ngôn ngữ** — nó là quét **first-match** trên một mảng in-memory có thứ tự,
nạp từ Postgres. Không parser, không sandbox, không expression language, không boolean combinator,
không JSON-Schema-trong-policy, không regex do operator cung cấp.

**Grant là default-deny và bắt buộc. Policy là default-allow và thuần trừ.**
Đây là thứ giữ nó ở 450 dòng thay vì 2000. **Bảng policy KHÔNG phải tầng phân quyền.**

| | |
|---|---|
| Subject | `any \| role \| api_key`. **Không có `user`** |
| Selector | `server_id uuid NOT NULL REFERENCES servers(id)` + `item_kind` + `name_pattern` (`*` là metachar duy nhất) |
| Effect | `allow \| deny` |
| Thứ tự | `UNIQUE(seq)` deferrable, reorder ghi `seq = idx * 10` trong một transaction |
| Ràng buộc argument | 7 phép cụ thể trên JSON pointer, **FAIL-CLOSED** khi path thiếu hoặc sai kiểu |
| Hết hạn | `expires_at` nullable — break-glass deny phải tự tắt |

> **Hai chỗ đâm vào quyết định đã chốt của chủ dự án, đã sửa:**
> `subjectKind = 'user'` **dựng lại đúng trục per-user vừa bị xoá** → bỏ khỏi enum.
> `serverSlug: text` làm selector → **đổi tên server âm thầm biến mọi deny rule thành no-op**:
> một thay đổi config ở màn này **tắt một biện pháp bảo mật ở màn khác**. Dùng `server_id` FK, render slug.

> **Lỗ HIGH.** `subjectMatches` không có nhánh machine. Principal machine không mang `role`,
> nên rule `role viewer → deny *` **không khớp API key của chính viewer đó** — tự phát key cho mình
> là bypass mọi deny theo role. Và hạ quyền `operator → viewer` vẫn thoát qua key phát trước đó.
> Vá: **`role` bắt buộc trên CẢ HAI nhánh** của `Principal`, **phân giải từ user sở hữu lúc authenticate**,
> **không bao giờ** đóng dấu vào metadata của key lúc phát.

**Annotation không bao giờ lái một quyết định lúc chạy.** Spec nói annotation là untrusted trừ khi
server đáng tin — nên mặc định *"`destructiveHint: true` thì siết"* là **để kẻ tấn công tự khai mình vô hại**.
Thay vào đó annotation **được gộp vào hash**: lật `destructiveHint` sau khi duyệt sẽ **quarantine** tool.
Mạnh hơn hẳn một default lúc chạy, và nó từ chối để upstream tự lập trình lớp policy của chính nó.

`pathUnder` ship **thành thật là lexical**, ghi nhãn trong code **và** trong helper text của UI,
thay vì một regex mà operator tưởng là biện pháp bảo mật. `Object.hasOwn` trong bước đi pointer và
`globMatch` tuyến tính — ReDoS và prototype pollution đóng **bằng cấu trúc**, không bằng kỷ luật.

**Explain bắt buộc.** Policy engine không giải thích được thì bị tắt. Mỗi rule render thành **một câu đọc được**
trong editor — đây là thứ chịu lực, không phải trang trí. Cộng phát hiện **shadow**: first-match nghĩa là
một `allow` rộng chèn lên trên **âm thầm vô hiệu mọi ràng buộc bên dưới**; quét containment O(n²) trên vài trăm dòng.

**Fail CLOSED lúc boot** (gateway không đọc được Postgres thì cũng không có catalog, grant hay secret để phục vụ —
nên `MCPR_STRICT_BOOT` là config cho một giá trị không bao giờ đổi, **xoá**).
**Fail STALE lúc refresh**, kèm gauge tuổi snapshot và banner hiện rõ. **Không bao giờ fail open.**
Không có `MCPR_POLICY_DISABLE` — break-glass không có lối thoát thì lối thoát không bị lạm dụng.

### 11.4 Seam trong core — và cái bẫy để lại zero dấu vết

Core **không** nhận khái niệm policy. Thay vào đó core tách `callTool` thành hai phương thức public,
và `callTool` trở thành **hợp của chúng**:

```ts
// packages/core — KHÔNG có policy, KHÔNG có approval, KHÔNG có operator, KHÔNG có HTTP
resolveTool(scope, principal, name): ResolvedTool        // ném ToolUnavailableError, đúng một chỗ dựng
callResolved(decision: Decision, opts): CallToolResult    // CHỈ nhận Decision đã đóng dấu

// packages/server — gate đúc ra Decision, và chỉ nó đúc được
const CHECKED: unique symbol
type Decision = { readonly [CHECKED]: true; tool: ResolvedTool; bytes: Uint8Array }
```

**Đóng dấu lên QUYẾT ĐỊNH, không phải lên phép phân giải.** Gate serialise argument **đúng một lần**,
hash **chính những byte đó**, và `callResolved` dispatch **chính những byte đó**.
Không còn reference nào để code trung gian — inject credential per-user, defaulting theo schema, chuẩn hoá —
sửa độc lập. Bypass trở thành **lỗi biên dịch tại đúng ranh giới thật**, không phải chuyện hai dòng code
tình cờ nằm cạnh nhau.

> Bản gốc để `policy?: PolicyGate` mặc định `ALLOW_ALL`. Toàn bộ lý lẽ đặt gate vào core là
> "bypass phải bất khả thi về cấu trúc" — rồi constructor biến việc **quên nối dây** thành
> **bypass toàn phần, im lặng, không dấu vết**, ở đúng chỗ **không test nào phủ** vì mọi test tự truyền gate.
> Vá: **bắt buộc**, export `ALLOW_ALL` để test và nhúng phải truyền tường minh và nhìn thấy được.

**Thứ tự check đầy đủ** — bổ sung vào §4.2 của spec này:

```
authenticate -> resolveTarget -> checkGrant -> resolveTool -> policy.evaluate
             -> egress scan -> approval -> Decision -> callResolved
```

**Policy chạy TRƯỚC egress scan** (bản gốc ngược lại). Đảo lại vì: oracle secret ở §11.6 nếu không
sẽ với tới được trên **mọi tool gọi được**, thay vì chỉ những tool policy cho qua. Và một `policy_deny`
không phải trả giá cho một lượt regex trên body 4 MB.

`prompts/get` và `resources/read` đi qua **cùng** gate. Bản gốc treo toàn bộ subsystem vào `tools/call`,
trong khi cache đã phủ cả prompt và resource và `isExposed` đã nhận `kind`. Caller bị chặn nhét credential
vào argument của tool thì **nhét vào argument map của `prompts/get`, hoặc vào query string của URI `resources/read`**,
và nó đi lên upstream **không bị quét**, không guardrail event, không đường approval.
Policy và approval cho prompt/resource **được phép hoãn với trần ghi rõ**; **quét egress thì không** —
nó là control duy nhất ở đây thật sự **chặn** thứ gì, và ship nó trên một trong ba method
**chính là định nghĩa của false confidence**.

### 11.5 Human-in-the-loop approval — phần khó là giao thức

`tools/call` là **HTTP POST đồng bộ**, ta đã tự chọn stateless, và era này **không có** kênh server→client
(MRTR còn chờ SDK). Gateway **không thể** hỏi model một câu giữa chừng.

**v1 ship (a) HOLD, với dòng approval kiêm luôn ticket dùng một lần** — nên (b) retry-sau-khi-duyệt
và (c) pre-approval rơi ra miễn phí.

| Hằng số | Giá trị | Vì sao |
|---|---|---|
| `MCPR_APPROVAL_HOLD_MS` | **55.000** | SDK mặc định timeout client **60s**. Bản gốc để 300.000 — tức 240 giây ghi keep-alive vào socket mà đầu kia đã bỏ cuộc, mỗi lần đốt một token pending budget và giữ tới 4 MB argument. Cơ chế đắt nhất thiết kế lại là cơ chế **ít có khả năng chạy nhất**. 55s để chữ `approval_pending` kịp vào context của model **trong lúc lượt còn sống** — và chính chữ đó khởi động vòng retry-sau-duyệt, con đường **thật sự** chạy được |
| Keep-alive | 15.000 | Dùng lại `MCPR_SSE_KEEPALIVE_MS` |
| TTL dòng pending | 900.000 | |
| TTL ticket sau duyệt | 600.000 | |

**Chỉ request TẠO ra card mới giữ kết nối.** Call giống hệt gặp card đang tồn tại thì trả `approval_pending`
**ngay lập tức** kèm `approvalId` + `retryAfterMs` — không hold, không token budget, chỉ `waiters++` để đếm.

> Không có vá này, chỉ dẫn retry và cap pending **đánh nhau, và bên thua là tính sẵn sàng**:
> `approval_pending` bảo model *"gọi lại với argument y hệt"*; làm thế thì bump waiters, lấy thêm một token
> budget và thêm một kết nối giữ. **Ba lần retry ngoan ngoãn** là model bị báo *"quá nhiều call của bạn đang chờ duyệt"*
> cho **đúng cái call nó vừa được bảo retry**. Client nào timeout 60s + retry tự động sẽ **tự DoS trong dưới 3 phút**.

**Hai bộ đếm tên khác nhau** (bản gốc để một con số mang hai nghĩa):
`maxPendingCardsPerPrincipal` (đếm trong DB, mặc định 3) gác việc **tạo card**;
`maxHeldPerPrincipal` (semaphore in-memory, mặc định 3 — thực tế thành 1 khi chỉ creator giữ) gác việc **hold**.

**Call đang chờ duyệt KHÔNG tính vào semaphore concurrency 8 của principal.** Nó nhả slot khi vào hold
và lấy token từ pending budget riêng (3 mỗi principal, 50 toàn cục). Khi được duyệt thì **lấy lại** slot
thực thi với ngân sách 10s.

**Từ chối hold khi argument lớn hơn 256 KB** — tạo card và trả `approval_pending` ngay.
`bodyLimit` 4 MB × pending budget toàn cục 50 = **200 MB worst case** argument giữ trong bộ nhớ, bản gốc không chặn.

#### Thứ tự lúc resume — bản gốc thiếu ba bước

```
re-verify credential (better-auth)  ->  acquire slot  ->  checkGrant  ->  resolveTool
  ->  definitionHash khớp?  ->  consume ticket  ->  dispatch
```

- **Re-authenticate.** Bản gốc chạy lại `checkGrant`/`resolveTool` trên một `Principal` vật chất hoá từ 5 phút trước.
  Thu hồi một key `mcpr_` bị lộ, xoá user, hoặc token OAuth hết hạn **giữa lúc hold** đều **không chặn được** call đang giữ.
  Đường retry thì tự nhiên re-authenticate — nên cơ chế thiết kế gọi là **chính** lại là cơ chế **yếu hơn**.
- **`definition_hash` trên `approval_request`.** `call_hash` chỉ phủ `{serverId, bareName, args}`, **không gì về tool LÀ CÁI GÌ**.
  Upstream phục vụ định nghĩa A lúc discovery và B sau reconnect thì **operator duyệt argument theo A, thực thi theo B** —
  và `resolveTool` chạy lại lúc resume trả về **định nghĩa MỚI**, nên bước re-check **tích cực tiếp tay** cho đòn tấn công.
  Đường ticket còn tệ hơn: cửa sổ 10 phút trùm trọn một chu kỳ reconnect.
  Lệch hash lúc consume: **không dispatch và không auto-deny** — hết hạn ticket, xếp card mới gắn nhãn
  *"định nghĩa tool đã đổi kể từ khi duyệt"*.
- **Dispatch fail trong ngân sách resume 10s là KHÔNG tiêu thụ ticket** — roll `remaining` lại trong
  cùng transaction ghi nhận thất bại. Không có điều này thì upstream flap **âm thầm ăn mất approval**
  (catalog stale khiến `resolveTool` thành công trên một upstream đã chết, rồi `callResolved` fail **sau khi** ticket đã tiêu).

#### Dedup và single-use — bản gốc mâu thuẫn chính nó

`waiters++` gộp N call giống hệt vào một card; card ghi *"2 calls waiting"*; operator duyệt;
`notifyWaiters` đánh thức cả N; nhưng UPDATE `LIMIT 1 FOR UPDATE SKIP LOCKED` chỉ cho **đúng một** tiêu thụ.
N−1 cái còn lại làm gì thì **không đặc tả**, và **mọi cách hiểu hợp lý đều sai**: hoặc chúng rơi xuống tạo card mới
(operator bị hỏi lại đúng cái vừa duyệt — chính sự mệt mỏi mà thiết kế tuyên bố đã giải quyết),
hoặc fail theo kiểu model không hành động được.

Vá: cột **`remaining integer`**, đặt bằng `waiters` lúc quyết định. Tiêu thụ là
`SET remaining = remaining - 1, status = CASE WHEN remaining = 1 THEN 'consumed' ELSE 'approved' END WHERE remaining > 0 … RETURNING` —
vẫn **một statement nguyên tử**. Card đọc thành thật: *"duyệt 2 call đang chờ"*.

#### Ai được duyệt — và CRITICAL của bản gốc

Approver là `operator` hoặc `admin`, check bằng route-group middleware đã có.
Cả bốn route approval **từ chối mọi principal không phải kind `user`** — một API key, kể cả key đã bị lộ,
**không bao giờ** duyệt được gì.

Tự duyệt **được phép mặc định**, luôn đóng dấu `self_approved: true` lên dòng, lên audit event và lên card.
`guardrails.requireSecondPerson` (mặc định false) biến nó thành 403.

> **CRITICAL đã vá.** `requireSecondPerson` trong bản gốc là **no-op hoàn toàn**: handler chạy
> `UPDATE … SET status='approved' … RETURNING *` **trước**, rồi mới check `if (requireSecondPerson && row.selfApproved) → 403`.
> Dòng **không** ở lại `pending` — nó **đã commit** là `approved` với `expiresAt` sống. Cái 403 chỉ chặn `notifyWaiters`.
> **Ticket nằm trong bảng và lần retry giống hệt kế tiếp của caller nuốt gọn nó.**
> Một operator có một API key **tự duyệt mọi call** trên một install tin rằng đang bắt buộc hai người.
>
> Vá: biến nó thành **tiền điều kiện, không phải hậu điều kiện**. Một statement, quyền sở hữu tính trong SQL
> và đẩy vào mệnh đề WHERE: `AND (NOT $requireSecondPerson OR $principalOwnerUserId IS DISTINCT FROM $meId)`.
> Tự duyệt dưới setting đó trả **zero dòng** và dòng **thật sự** không bị đụng tới.

#### Chống mệt mỏi — và chống việc biến nó thành "duyệt tất"

**Không có nút "approve all"** ở bất cứ đâu trong UI hay API.
Affordance hàng loạt duy nhất là `scope: 'tool'` — duyệt đúng bộ ba `(principal, server, tool)` trong
**15 hoặc 60 phút**, TTL từ enum cố định, **không bao giờ** tự do nhập — tự giải quyết mọi card đang xếp khớp bộ ba đó.

> **Cửa sổ grant phải có cap SỐ LẦN DÙNG.** Bản gốc để `use_count` tăng mãi tới `expiresAt`:
> *"duyệt 15 phút"* nghĩa là **không giới hạn** call tới tool đó với **argument tuỳ ý** trong 15 phút —
> biến đúng đòn tấn công mệt mỏi mà thiết kế nói đã đánh bại thành **đúng cái quyền blanket** nó nói là không với tới được:
> spam tới khi operator chọn lối thoát duy nhất UI đưa ra, rồi bắn mười nghìn call.
> Vá: `max_uses` (mặc định **20**, cùng cách xử lý enum cố định như TTL), cưỡng chế trong **cùng** UPDATE:
> `AND use_count < max_uses`. Ghi vào dialog: *"tối đa 20 call, tới 14:27"*.

Deny vào **cooldown 10 phút** — retry giống hệt bị từ chối mà không tạo card mới.
**Nhưng phải huỷ được deny**: một cú click nhầm + cooldown + không có lối đổi quyết định
là **lý do khả dĩ nhất khiến operator tắt cả subsystem**. Cho phép re-decide một card đã deny
trong `denyCooldownMs`; nó thành ticket thường, audit thành `approval.decided` thứ hai mang theo quyết định trước.

#### Argument mà approver nhìn thấy

`approval_request` **không có cột raw-arguments**. Nó lưu `args_preview` (chiếu lá đã redact, DB CHECK cap **8 KB**)
và `args_bytes`. Argument đầy đủ **chỉ tồn tại trong bộ nhớ của process đang giữ**, nên
`GET /api/approvals/:id/args` **chỉ chạy khi `held = true`**, đòi `audit:payload:read` **cộng thêm** role operator,
và ghi audit event `approval.args.read`.

> **Retention — bản gốc làm sai chính tuyên bố đầu bài của nó.** Sweep chỉ chạm `pending`/`approved`.
> Dòng `denied`, `expired`, `consumed` **sống mãi**, mỗi dòng mang `args_preview` giữ nguyên văn scalar
> tới 256 ký tự trên tối đa 64 lá — **tới 8 KB vật liệu argument thật, vĩnh viễn**.
> *"Hàng đợi approval không thể trở thành kho lưu argument kể cả khi database bị đánh cắp"* đúng trong
> mười lăm phút và **sai sau đó**.
> Vá: **null `args_preview` ngay lúc quyết định**, cộng một sweep retention có ngày bên cạnh sweep 30s đã có.

**Card là bề mặt ra quyết định đang render hai chuỗi do kẻ tấn công ảnh hưởng như thể là sự thật:**
`sourceIp` (sau reverse proxy đây là địa chỉ của proxy hoặc `X-Forwarded-For` giả được) và
`principalName` (với apiKey đây là **tên do người dùng tự đặt** — `"github (pre-approved by admin)"`, hoặc homoglyph của một key tin cậy).
Operator liếc card lúc 3 giờ sáng đang đọc **văn bản do người yêu cầu tự chọn**.
Vá: `sourceIp` chỉ điền khi có cấu hình số hop proxy tin cậy, còn lại render `unknown` chứ không render một lời nói dối;
`principalName` render qua `<Id>` mono, cap độ dài cứng, không style, và **luôn hiện kèm id apiKey bất biến của better-auth** —
id mới là thứ operator kiểm chứng được.

#### Boot và thông báo

- **Reset `held` lúc boot**: `UPDATE approval_request SET held = false WHERE held` dưới `pg_advisory_lock` đã có.
  Đường abort đặt `held=false`; **crash thì không**. Sau restart, dòng còn `held=true` mà không còn argument trong bộ nhớ,
  nên `GET …/args` hoặc 500 hoặc 410 trong khi card vẫn bảo operator rằng có caller đang chờ.
- **Frame SSE**: số pending toàn cục đi vào frame **`status`** đã có (nó là một con số trạng thái);
  `approval` là frame họ **`changed`** thuần, chỉ invalidate `['approvals']`.
  Giữ **đúng hai** hành vi cache, không đẻ ra luật thứ ba đội lốt hai luật.
- **Không ai mở console**: card vẫn xếp, hold vẫn timeout ở 55s, caller nhận `approval_pending` kèm `approvalId`.
  Duyệt muộn vẫn thành ticket mà lần gọi giống hệt kế tiếp tiêu thụ được ngay.
- **Ghi audit cho quyết định là ĐỒNG BỘ, trong CÙNG transaction với UPDATE quyết định** — không phải
  statement thứ hai, không phải connection thứ hai. Đây là **ngoại lệ duy nhất** với hàng đợi audit có biên ở §8,
  cùng với `approval.args.read`; ghi vào §8 để implementer sau không định tuyến chúng qua queue và giết bất biến trong im lặng.

### 11.6 Nội dung không tin cậy — tách thật khỏi diễn

| Cơ chế | Đánh giá | Chặn hay báo |
|---|---|---|
| Khớp **literal giá trị secret ta quản lý** | **THẬT.** Ta *biết* giá trị — bảng `secrets` giữ chúng | **CHẶN** |
| Regex PII chung chung | **DIỄN.** Đúng lý do ta đã bác redaction heuristic ở §8 | không ship |
| Regex "hình dạng secret" chung chung | **DIỄN.** Như trên | không ship |
| Heuristic phát hiện prompt-injection trên kết quả | **DIỄN.** Và gateway cũng không kiểm soát được model client đóng khung nội dung ra sao | không ship |
| Nhãn provenance `_meta` | Rẻ, trung thực, **chỉ giúp client nào CHỌN tôn trọng** | báo |
| Bytes / blocks / truncatedBytes | Rơi ra miễn phí từ bước truncate đã có | báo |

**Quét egress — và ba lỗ HIGH của bản gốc:**

```ts
// packages/core/src/secrets/resolver.ts — CHỈ export predicate.
// Plaintext KHÔNG BAO GIỜ rời module này. Matcher là một field trên instance resolver
// mà Engine đã sở hữu (KHÔNG phải module-level `let` — hai Engine trong một process,
// và mọi file test trong một worker, sẽ dùng chung một matcher).
findManagedSecrets(serialised: string): Array<{ secretId, label }>
```

1. **Đừng duyệt cây để phát hiện.** Bản gốc `walkStrings(args, '', 16, 4096, …)` — depth ≤16, ≤4096 lá,
   **cả hai cap đều âm thầm dừng quét**. Nhét một object 4096 lá một ký tự (vài KB, xa mức 4 MB) và
   đặt credential ở lá **thứ 4097**, hoặc lồng sâu **17 tầng**: `findManagedSecrets` trả `[]`, call được cho qua.
   Vá: chạy alternation **một lượt trên `JSON.stringify(args)`** — không cap, một pass, **nhanh hơn** duyệt cây —
   rồi mới duyệt cây **chỉ để tính JSON pointer cho báo cáo** (lượt duyệt đó cap thoải mái; một hit với pointer
   không xác định **vẫn là chặn**).
2. **Bypass encoding.** Bản gốc phủ 3 dạng (literal, base64 không đệm, `encodeURIComponent`).
   `base64url`, base64 **có** đệm và hex **đi thẳng qua** — mà `base64url` chính là dạng của một token
   đã đi qua URL hoặc JWT. Phủ **đủ sáu**: literal · base64 có đệm · base64 không đệm · base64url · hex hoa/thường · percent.
   Bốn entry nữa trong **cùng** alternation, chi phí như nhau. (Critique: *"đừng ship một matcher phủ ba trong sáu
   dạng với tới được dễ dàng trong khi message chặn khẳng định credential 'thật sự' không thể ra ngoài"*.)
3. **Oracle xác nhận.** Text trả về cho caller ở bản gốc **nêu tên label**: *"contains a credential MCPRouter manages (github.PAT)"*.
   Caller là **bên không tin cậy**. Bất kỳ ai với tới một tool không cần duyệt đều **test được một chuỗi ứng viên
   bất kỳ với secret của install và nhận câu trả lời dứt khoát**, kèm nhãn người đọc được — và **liệt kê được
   không gian label** qua mỗi lần trúng.
   Vá: text hướng model **chỉ** mang lý do và JSON pointer — *"Blocked: argument `/token` chứa một credential MCPRouter quản lý.
   Không có gì được gửi lên upstream."* Strip `label` và `secretId` khỏi `GuardrailMeta.secretHits` **trên dây**.
   Label ở lại trong audit event và card của operator — hai chỗ duy nhất nó có ích.

`guardrails.secretEgress: block | require_approval | report`, mặc định **`block`**.
Ceiling được ghi thẳng: giá trị secret dài **≥ 16 ký tự** mới vào matcher.

**Nhãn provenance**: `_meta['io.mcprouter/provenance']`, **luôn bật**, năm dòng, không mutate gì.
**Cắt** chế độ `meta+wrap`: phong bì hai block, nonce base32 110-bit, `envelopeId`, dự trữ 512 B cho truncation,
luật thứ tự và cả setting `labelling`. Thiết kế **tự nói** không client nào tôn trọng nó và nó mặc định tắt —
tức ở v1 nó là một setting, một bộ sinh nonce, một tương tác đã tài liệu hoá với trần 1 MB, một bất biến thứ tự
và một bộ test, **cùng nhau tạo ra đúng zero thay đổi hành vi cho mọi install**. Giữ tham số nonce
dưới dạng comment ba dòng cho người thêm wrapping sau này.

**Cắt `inspectResult()`**: `links{total,distinct,oddSchemes,hosts[]}`, `mimeTypes[]`, lượt quét `URL_RE`
trên 256 KB đầu của **mọi** kết quả, hai counter, và `result_shape` trên **mọi** dòng audit `tool.call`.
Không gì tiêu thụ chúng. Không thể biện minh cho một tín hiệu suy đoán bằng cách chỉ vào cái follow-up mà nó cho phép.
Giữ `bytes`, `blocks`, `truncatedBytes` — cả ba rơi ra miễn phí từ bước truncate đã có.

**Mọi từ chối của guardrail là `CallToolResult` với `isError: true`**, một text block phẳng và
`_meta['io.mcprouter/guardrail']`, ở **HTTP 200** — **không phải** JSON-RPC error.
Lý do: nhiều client coi JSON-RPC error là lỗi transport và **retry**, đánh bại đúng mục tiêu
"làm model dừng vòng lặp retry"; còn `{isError:true, content:[…]}` **vào context của model một cách đáng tin**.
Tập lý do: `policy_deny | approval_pending | approval_denied | approval_timeout | approval_queue_full |
approval_cooldown | secret_egress | guardrail_unavailable`.

> Điều này **không** vi phạm luật một-message ở §4.1: gate chỉ chạy **sau khi** `resolveTool` đã xác nhận
> tool tồn tại và trong scope, nên không rò gì mà caller chưa nắm. Giữ nguyên câu này trong spec
> để người review sau không "sửa" nó.

**Chặn vì guardrail phải hiện cho operator.** `secret_egress` hay `guardrail_unavailable` ở bản gốc
chỉ tới model và vào `audit_event`. Câu chuyện false-positive (*"sửa bằng một checkbox, đã nêu trong message lỗi"*)
giả định operator **đọc** message — nhưng message được giao cho **model**, trong một cuộc chat operator có thể không có mặt.
False positive đầu tiên vì thế được chẩn đoán bằng cách **grep `audit_event`**, không phải bằng một cú click.
Vá: emit block lên kênh `/api/events` đã có (chỉ `operator|admin`) và badge trong console.

### 11.7 Bảng mới và cột mới

| Bảng / cột | Ghi bởi | Ghi chú |
|---|---|---|
| `tool_embedding.def_hash`, `.shape_hash`, `.defect`, `.def_seen_at` | engine, lúc cache | Sự thật. Upsert `WHERE def_hash IS DISTINCT FROM $new` — giết churn khi flap |
| `server_item_override.review_state`, `.approved_hash`, `.approved_def jsonb`, `.approved_by uuid REFERENCES "user"(id) ON DELETE SET NULL`, `.approved_at` | operator | Ý kiến. `changed` **suy ra**, không lưu. Bản gốc để `approved_by text` denormalised — luật no-FK chỉ áp cho `audit_event`, đây là **config sống** |
| `servers.first_enabled_at timestamptz` | hệ thống | Chặn rửa quarantine bằng disable/enable |
| `servers.trust` | operator | `text` + CHECK. Chỉ đẩy tiếp approval **đã có** cho **tên không đổi** |
| `policy_rule` | operator | `seq UNIQUE` deferrable · `server_id` FK · subject `any\|role\|api_key` · effect `allow\|deny` · `expires_at` nullable · `note varchar(200)` text-only |
| `approval_request` | hệ thống + operator | `call_hash` · **`definition_hash`** · `args_preview` (CHECK 8 KB) · `args_bytes` · `remaining` · `max_uses` · `held` · `self_approved` · `decided_by` · `expires_at`. CHECK đặt tên `approval_decision_complete` (bản gốc đặt `approval_human_only` — **tên nói quá thứ nó kiểm tra**, đúng loại false confidence thiết kế này từ chối ở chỗ khác; bất biến "API key không duyệt được" sống **hoàn toàn** ở route middleware, ghi vào comment bảng) |

**Sáu pgEnum của bản gốc đổi thành `text` + CHECK.** Postgres enum **không drop được value** và
reorder cần rewrite type — mà ta sẽ muốn drop `require_approval` và `user` trong vòng một tháng.
Drizzle mô hình hoá `text().$type<…>()` + CHECK y hệt, và union zod mới là validator thật.

> **Cảnh báo vận hành.** Thêm cột `scan_egress` vào `secrets` **đổi AAD** nếu AAD đúng nghĩa là "các cột" —
> và **mọi secret đang có sẽ không open được ở lần boot kế tiếp**: mất toàn bộ upstream, im lặng.
> Migration **phải** nêu rõ AAD là một **danh sách field đóng băng tường minh** (`id ‖ server_id ‖ key`)
> và `scan_egress` **nằm ngoài** danh sách đó. Một check chạy được: seal một dòng, thêm cột, open lại.

### 11.8 Metric

```
mcprouter_policy_decision_total{effect}          counter
mcprouter_integrity_block_total{reason}          counter
mcprouter_approval_total{outcome}                counter
mcprouter_secret_egress_block_total              counter
mcprouter_policy_snapshot_age_seconds            gauge
```

`rule_id` và `tool` thuộc **counter riêng, không bao giờ nhân chéo** — luật cardinality §8.
Gộp deny giống hệt trong cửa sổ flush theo `(principal, ruleId, server, item)`, phát **một** dòng kèm `count`:
không có nó, gây ra một deny là **miễn phí và hoàn toàn do caller điều khiển**, nên một agent lặp vô hạn
**đánh bật mọi dòng `tool.call` khác** ra khỏi hàng đợi audit có biên 10.000 — **lạm dụng guardrail để làm mù chính nhật ký audit nó dùng chung**.

Không có `mcprouter_policy_decision_total` thì **không alert được** *"policy bắt đầu deny mọi thứ lúc 02:00"* —
đúng kiểu hỏng mà một danh sách first-match có thứ tự khiến rất dễ gây ra bằng **một dòng đặt sai chỗ**.

### 11.9 Đã cắt khỏi v1

| Cắt | Vì sao |
|---|---|
| Bộ sinh starter-ruleset từ annotation | Một code generator cho một UI cho một rule engine có **zero người dùng** và bốn rule ví dụ. Link tới editor rỗng + 4 ví dụ copy-paste trong docs là đủ |
| `MCPR_STRICT_BOOT` | Config cho một giá trị không bao giờ đổi |
| Hai body shape cho `POST /api/review/approve` | Cái thứ hai là cái thứ nhất cộng "select all" phía client. Hai validator, hai hình dạng audit, hai đường TOCTOU |
| `defect = 'uncanonicalizable'` | Nhánh chết. `canonical()` chỉ throw được ở depth (đã là defect riêng), bigint hoặc cycle — không cái nào sống sót `JSON.parse` một payload upstream |
| `meta+wrap` envelope + nonce + setting `labelling` | Zero thay đổi hành vi cho mọi install ở v1 |
| `inspectResult()` link/host/mime scanning | Không gì tiêu thụ. Regex trên 256 KB ở hot path của mọi call, mãi mãi |
| `ArgsPreview` `v:1` / `type` / `foldedLeaves` | Wire format bespoke có version cho một projection mà độc giả duy nhất là một cái card. Giữ CHECK 8 KB — cái đó **chịu lực** |
| `subjectKind = 'user'` | Dựng lại trục per-user đã bị xoá |
| `schema_hash` | Thay bằng `approved_def jsonb`, vốn giải quyết được nhiều hơn |

### 11.10 Chi phí thật

| Việc | Phase | Tuần |
|---|---|---|
| Tách `resolveTool` / `callResolved` trong core | **P1** | **+0.0** — refactor code đang viết dù sao. Đặt ở P7 nghĩa là P1 dựng call path theo `callTool` rồi P7 viết lại |
| Hash + 4 cột + vế AND trong `isExposed` + `policy_rule` + `evaluate` + seam gate + ~12 case bất biến | **P2** | **+1.25** |
| Review queue · diff pointer-flatten · rule editor với render câu · explain drawer · shadow detection | **P3** | **+1.5** |
| Nhãn provenance · `findManagedSecrets` · `secret_egress` · hai counter | **P4** | **+0.25** |
| Giao thức approval · `approval_request` · frame SSE · màn queue · CLI · 5 audit event | **P7** | **+1.5** |
| **Cộng thêm** | | **+4.5** |
| **TỔNG DỰ ÁN** | | **12.5 → 17.0 dev-week** |

Lịch thật: **~5 tháng cho một dev**, hoặc **~13 tuần cho hai dev**.

> Ước lượng của cả hai agent đều hụt (+2.0 và +1.0). Critique tính lại và bắt được những gì bị bỏ sót:
> `approved_def`, audit cho integrity block, cap upstream, shadow detection, preview khi lật setting,
> ràng buộc approval theo argument, và việc tách core API vốn thuộc P1 chứ không phải P7.
> Nói con số này **bây giờ** tốt hơn phát hiện nó ở P7.

`$smart` **phải** viết để `call_tool` gọi `guardedCall` phía server **ngay từ P5**, không phải đi dây lại ở P7 —
nếu không meta-tool trở thành đường đặc quyền vòng qua mọi guardrail.
Test bắt buộc: lỗi cho tool không tồn tại / bị disable / ngoài group phải **byte-identical** giữa
đường gọi trực tiếp và đường qua `$smart`.

---

## 12. Nền tảng kỹ thuật

| | |
|---|---|
| Build | `tsc -b` cho core/server/cli, `vite build` cho web. Không tsup, không unbuild, không script esbuild. `verbatimModuleSyntax: true`, `module: nodenext`, đuôi `.js` tường minh trong import tương đối |
| Phân phối | Hub **chỉ** là Docker image multi-arch trên GHCR. CLI **chỉ** là npm package `mcprouter` (~60 KB, zero runtime dep, `node:util.parseArgs` + global fetch). Subcommand lạ thì in usage và exit 1 — **không** fall-through sang `serve` như `bin/cli.js` của mcphub |
| Config | **Một** zod schema cho mọi env var, parse một lần lúc boot. Fail thì in **mọi** issue dạng `VAR: message` kèm gợi ý sửa, **không** in giá trị, rồi `process.exit(78)` (EX_CONFIG). `AUTH_SECRET`, `DATABASE_URL`, `PUBLIC_URL` **bắt buộc, không fallback**. Mọi secret nhận thêm dạng `<VAR>_FILE`. Object config có `toJSON` redact để `logger.info({config})` lỡ tay không rò |
| Docker | `node:22-bookworm-slim` + `uv`/`uvx` copy dạng binary tĩnh từ `ghcr.io/astral-sh/uv` + một CPython managed bake sẵn lúc build. Thêm `git`, `ca-certificates`. **Hết.** `USER node`. **Không** biến thể INSTALL_EXT, không Rust, không Docker-in-Docker, không Playwright, không procps. Mục tiêu ≤400 MB uncompressed, amd64 + arm64 |
| Test | **vitest 5**. Ba tầng theo đuôi file: `*.test.ts` (unit, không I/O, đặt cạnh nguồn) · `*.itest.ts` (integration, Postgres thật qua `@testcontainers/postgresql` chạy **đúng** image `pgvector/pgvector:pg16` production dùng) · `test/e2e/*.e2e.ts` (client SDK **thật** đánh vào server đã build, qua upstream fixture **thật**). `retry: 0` trong CI — test flaky thì **xoá**, không retry |

### CI — gate ở số cuối cùng ngay từ P0

Mỗi PR chạy: install frozen-lockfile → oxlint + `prettier --check` → **`pnpm build`** (tsc -b + vite build) →
unit → integration (testcontainers) → **e2e** → `drizzle-kit generate` + `git diff --exit-code drizzle/` →
Docker build amd64 (không push).

Coverage gate: global lines 70 / functions 70 / branches 60.
Gate cứng theo glob: lines **90** / branches **85** trên `packages/core/src/security/**` và
`packages/core/src/tools/**`; 85/75 trên `packages/server/src/mcp/**`.
Timeout cứng 8 phút cho job e2e.

**PR nào sửa `.github/workflows/ci.yml` để skip hay disable một job đều cần một approval thứ hai qua CODEOWNERS.**

Đặt gate ở số cuối cùng từ P0 là có chủ ý: lúc đó chưa có code nên chúng pass sẵn.
Gate không bao giờ "bật sau" — đó **chính xác** là cách job build và integration của mcphub kết thúc ở trạng thái comment hết.

Supply chain: mọi GitHub Action pin theo commit SHA, `permissions: contents: read` ở cấp workflow,
dùng `pull_request` (**không bao giờ** `pull_request_target`) nên job PR không giữ secret, PR build không push.
Release theo tag: buildx multi-arch push GHCR với `--provenance --sbom`, cosign keyless qua GitHub OIDC,
`npm publish --provenance` cho CLI.

### Shutdown và ceiling multi-replica

SIGTERM: ngừng nhận connection mới, để tool call đang bay hoàn tất tới `SHUTDOWN_TIMEOUT_MS` (mặc định 10s),
SIGTERM rồi SIGKILL **process group** của mọi stdio child, đóng pool, exit 0.

> **Trần đã ghi rõ**: vì v1 phục vụ legacy era, state session downstream nằm trong bộ nhớ `packages/server`,
> nên deployment nhiều replica cần session affinity trên `/mcp`. Mọi thứ khác — `AUTH_SECRET` bắt buộc,
> migration dưới advisory lock, không config in-memory — đã replica-safe sẵn.
> Spec `2026-07-28` xoá thẳng yêu cầu này.

---

## 13. Kế hoạch triển khai

Kích thước tính bằng dev-week cho **một** dev full-stack mạnh.

### P0 — Skeleton biết boot · 1.0w · deps: không

pnpm workspace + 4 package + `tsc -b` project references · zod config schema fail-fast exit 78 ·
drizzle schema stub + migration runner dưới `pg_advisory_lock` · Dockerfile + compose với pgvector health-gated ·
pino + request-id · `/health/live|ready` · `/metrics` · vitest + testcontainers harness ·
CI với **mọi gate đã ở số cuối cùng**.

**Demo**: `docker compose up` → ready <15s · `curl /health/ready` 200 ·
bỏ `AUTH_SECRET` → process exit 78 in đúng
`AUTH_SECRET: must be at least 32 characters — run 'mcprouter secret'` và không gì khác ·
CI xanh trên một PR rỗng.

### P1 — Một tool, đầu đến cuối · 2.0w · deps: P0

**Guardrail +0.0w**: tách core thành `resolveTool` + `callResolved(decision)`, `callTool` = hợp của chúng (§11.4) — refactor code đang viết dù sao.

Core upstream registry (generation counter + `connectStillWanted` guard) · stdio + streamable-http + sse upstream ·
SSRF guard với validate mỗi redirect · tool cache namespace `<server>__<tool>` lúc cache ·
server: legacy-era Streamable HTTP `POST /mcp`, **405 cho GET/DELETE** (ta không bao giờ ship standalone stream
nên cái này miễn phí) · better-auth core + apiKey plugin nối vào như **cấu hình, không phải code**.

**Demo**: `mcprouter servers add` một filesystem server chạy bằng npx, tạo một key, trỏ Claude Code vào
`https://hub/mcp` với bearer key đó, list và call một tool. **Client thật qua upstream thật ở ngày thứ 21.**

### P2 — Scope và bất biến visibility · 1.5w · deps: P1

**Guardrail +1.25w** (§11.2, §11.3): hash định nghĩa + 4 cột + vế AND trong `isExposed` · `first_enabled_at` · cap response upstream · `policy_rule` + `evaluate` + seam gate đóng dấu · ~12 case bất biến.

Group = membership + item selection trong một record · enable/disable per-tool enforce **lúc gọi**, không chỉ lúc list ·
lỗi hidden ≡ lỗi không tồn tại · full-containment key↔group · audit row ghi mỗi call.

**Demo**: hai key, hai group. Key A list 4 tool, key B list 2.
Gọi tool chỉ-của-A bằng key B trả về response **byte-identical** với gọi một tool chưa từng được định nghĩa.
Đây là phase gate coverage 90% per-glob của security bắt đầu có hiệu lực.

### P3 — Console vận hành · 2.5w · deps: P2 · **điểm rẽ nhánh tự nhiên nếu có dev thứ hai**

**Guardrail +1.5w** (§11.2, §11.3): review queue · diff pointer-flatten (bidi-safe) · rule editor render câu · explain drawer · shadow detection.

Vite + React 19 + `@theme` token block + shadcn/ui cài đúng cách + TanStack Query + cmdk palette ·
servers grid với status dot sống · server form · groups · keys · users · log stream · điều hướng bàn phím trước.

**Demo**: một operator chưa từng thấy CLI: thêm server → dựng group → phát một key scoped → copy block client config.
Toàn bộ trên browser, dark, dày, không trang nào quá 1.5s tới interactive.

### P4 — Observability thật · 1.0w · deps: P1

**Guardrail +0.25w** (§11.6): nhãn provenance `_meta` · `findManagedSecrets` · chặn `secret_egress` · counter guardrail.

prom-client histogram per server/tool/outcome · OTel sdk-node chỉ start khi có `OTEL_EXPORTER_OTLP_ENDPOINT` ·
pino JSON + pino-roll file sink · request-id lan truyền client→hub→upstream · activity log persist + retention job ·
`/api/health` deep view · sparkline latency per-server trên UI.

**Demo**: một panel Grafana p95 tool latency per upstream, và **một** distributed trace trải suốt client → hub → upstream.

### P5 — Context Cost + Smart Routing · 2.0w · deps: P2, P0

Đếm token cl100k trên **đúng** payload sẽ lên dây · gross vs exposed per server và per group ·
meta-tool `$smart` với progressive disclosure — `call_tool` gọi `guardedCall` phía server **ngay từ đây**, không đi dây lại ở P7 (§11.10) · pgvector cosine với scope predicate đẩy **vào trong** SQL ·
embedding sync skip bằng hash tool-set.

**Demo**: một group 14 server tốn 61k token định nghĩa tool **tụt xuống 1.2k** dưới `$smart`, UI hiện cả hai số cạnh nhau,
và `search_tools` vẫn tìm đúng tool. Test regression: search có scope trên fixture 1000 dòng trả **zero** dòng ngoài scope ở `LIMIT 5`.

### P6 — Marketplace và install · 1.0w · deps: P3

Proxy `registry.modelcontextprotocol.io` **có cache** · install flow ghi ra server config · dry-run trước khi persist.

**Demo**: search registry từ cmdk palette, Enter, 10 giây sau server đã connect và tool đã được list.

### P7 — Hardening và 1.0 · 1.5w · deps: tất cả

**Guardrail +1.5w** (§11.5): giao thức approval HOLD + ticket · `approval_request` · frame SSE · màn queue · CLI · 5 audit event.

Secret mã hoá at rest — token OAuth upstream, env, headers, AES-256-GCM với AAD
(**đây là điểm khác biệt đầu bảng, không phải chỗ cắt góc**) ·
OAuth client upstream với discovery RFC 9728 + `resource` RFC 8707 trên **cả** authorize và token ·
MCPRouter-as-AS qua better-auth `mcp` plugin với **DCR để TẮT** · rate limit qua apiKey plugin ·
pass accessibility (role, focus trap, không emoji làm UI) · docs · e2e trên image đã release · multi-arch signed release.

**Demo**: `docker run ghcr.io/…/mcprouter:1.0.0`, năm operator, ba client, và `pg_dump | grep -c 'sk-'` trả về **0**.

### Tổng

**17.0 dev-week** — 12.5 nền + **4.5 guardrail** (§11.10).
Lịch thật: **~5 tháng cho một dev** (17w + ~30% cho quirk của SDK, upstream server cư xử bậy, và review),
hoặc **~13 tuần cho hai dev** rẽ nhánh ở P3 (web) / P4–P5 (backend).

Ước lượng ban đầu của cả hai agent guardrail đều hụt (+2.0 và +1.0). Critique đối kháng tính lại và bắt được
phần bỏ sót: `approved_def`, audit cho integrity block, cap response upstream, shadow detection,
preview khi lật setting, ràng buộc approval theo argument, và việc tách core API vốn thuộc P1 chứ không phải P7.

> Ai hứa 1.0 trong sáu tuần là đang lên kế hoạch xoá một cái gate.

### Không nằm trong plan: P8 — Modern era

**Trigger**: `@modelcontextprotocol/sdk` ship `LATEST_PROTOCOL_VERSION = '2026-07-28'`.
**Kích thước: 1.0w NẾU P1 giữ đúng kỷ luật** — một handler mới `packages/server/src/mcp/modern.ts` cạnh `legacy.ts`,
plumbing MRTR `InputRequiredResult`, `subscriptions/listen`, `-32020`/`-32022`, và xoá session map.

**Thành 6 tuần viết lại nếu danh tính session từng rò vào `packages/core`** — đó chính là lý do
tsconfig project reference và `packages/core/package.json` (không hono, không better-auth) cấm cửa nó **từ P0 trở đi**.

---

## 14. Spike xác minh — ĐÃ CHẠY, kết quả đo thật

> Chạy 2026-09-19 với đúng bộ version đã pin, Node v22.22.0. Mọi kết luận dưới đây đến từ **code đã thực thi**,
> không phải đọc `.d.ts`. Script và kết quả đầy đủ: `docs/superpowers/spikes/spike{1..8}.json`.
> **5 CONFIRMED · 2 PARTIAL · 1 REFUTED.**

| # | Giả định | Kết quả |
|---|---|---|
| 1 | `InMemoryTransport.createLinkedPair()` | ✅ **CONFIRMED** — mang trọn phiên initialize + tools/list + tools/call in-process. Fallback ~50 LOC **xoá khỏi budget** |
| 2 | Override `fetch` trên HTTP transport | ✅ **CONFIRMED** — fallback undici không cần |
| 3 | stdio `stderr:'pipe'` + `getDefaultEnvironment()` | ⚠️ **PARTIAL** — hai cái đó đúng; **`detached` thì không tồn tại** |
| 4 | Web-standard transport tôn trọng `sessionIdGenerator: undefined` | ✅ **CONFIRMED** — kèm **hai ràng buộc bắt buộc** spec chưa nêu |
| 5 | better-auth `apiKey` + `disableSessionForAPIKeys` | ❌ **REFUTED** — package khác, tên option khác, **và quyết định `metadata` bị lật ngược** |
| 6 | `auth.api.getMcpSession()` lộ audience | ⚠️ **PARTIAL** — hàm đó **không tồn tại**; thứ thay thế **mạnh hơn** |
| 7 | PRM mount path, DCR tắt được | ✅ **CONFIRMED** — và plugin tự phục vụ cả hai path, **xoá route wildcard đã định viết** |
| 8 | Client thật chịu được stateless | ✅ **CONFIRMED** cho client dựa trên SDK |

### 14.1 Dependency — spec cũ sẽ **gãy ngay `pnpm install`**

better-auth 1.7.5 đã **tách plugin ra package riêng**. Mọi dòng `import { apiKey } from 'better-auth/plugins'`
hay `import { mcp } from 'better-auth/plugins'` **không compile**.

```jsonc
"better-auth":                "1.7.5",
"@better-auth/api-key":       "1.7.5",   // apiKey plugin
"@better-auth/mcp":           "1.7.5",   // OAuth 2.1 AS cho MCP client
"@better-auth/oauth-provider":"1.7.5",   // @better-auth/mcp kéo theo
"@better-auth/cimd":          "1.7.5"    // Client ID Metadata Documents
```

Tất cả khoá version cùng core qua peerDeps (`better-auth: ^1.7.5`, `better-call: 1.4.0`).
**`mcp()` throw lúc khởi động nếu thiếu `jwt()` trong danh sách plugin** — thêm nó.

### 14.2 API key — REFUTED, và đây là chỗ đáng giá nhất của cả đợt spike

**Option `disableSessionForAPIKeys` KHÔNG TỒN TẠI.** Tên thật là **`enableSessionForAPIKeys`**,
**đảo cực**, và giá trị an toàn `false` **đã là mặc định**.

> **Và tên sai FAIL TRONG IM LẶNG.** Không validate, không reject. Instance dựng với
> `{ enableSessionForAPIKeys: true, disableSessionForAPIKeys: true }` **vẫn mint session đầy đủ của chủ key**.
> Không có lỗi lúc chạy nào bắt được. Viết theo spec cũ là ship ra **đúng lỗ mcphub**
> — API key của admin thành admin — với **zero tín hiệu**.

**Quyết định `metadata` LẬT NGƯỢC.** §5.2 cũ nói để grant trong `metadata.grant`. **Không được.**

Với `enableMetadata: true`, **chính chủ key ghi được metadata tuỳ ý** qua
`POST /api/auth/api-key/create` **và** `/update`, chỉ cần session cookie của họ.
Đã verify: chủ key set `{role:"admin", tenant:"evil"}` rồi update lại, **cả hai HTTP 200**.

`permissions` thì được canh bằng `SERVER_ONLY_PROPERTY` và **reject 400** trên cả hai route client-facing.

→ **Mọi grant phân quyền đi vào `permissions`. `metadata` là input không tin cậy do chủ key điều khiển. Giữ `enableMetadata: false`.**

```ts
import { apiKey } from '@better-auth/api-key';   // KHÔNG phải 'better-auth/plugins'

apiKey({
  enableSessionForAPIKeys: false,  // tên thật, cực đảo. Mặc định đã false —
                                   // viết tường minh làm dây bẫy cho người sau.
  enableMetadata: false,           // bật lên là chủ key tự ghi metadata qua HTTP.
  apiKeyHeaders: 'x-api-key',
  defaultKeyLength: 64,
  keyExpiration: { defaultExpiresIn: null, disableCustomExpiresTime: true },
  rateLimit: { enabled: false },   // MẶC ĐỊNH LÀ BẬT, 10 request / NGÀY.
                                   // Để nguyên là brick mọi key ở request thứ 11.
  permissions: { defaultPermissions: { mcp: ['read'] } },
})
```

Mint qua route của ta (`permissions` chỉ nhận được từ phía server):

```ts
const created = await auth.api.createApiKey({ body: {
  name, userId: ownerId, prefix: 'mcpr_',
  expiresIn: 60*60*24*30,          // GIÂY (config plugin dùng MILLI, min/max dùng NGÀY — ba đơn vị)
  permissions: { mcp: ['all'] },
}});
created.key;    // plaintext, CHỈ trả về ở đây
created.start;  // 'mcpr_x' — 6 ký tự đầu, an toàn hiện trên UI
```

Verify trên hot path — **chỉ server-side, không có HTTP route**:

```ts
const res = await auth.api.verifyApiKey({ body: { key, permissions: { mcp: ['all'] } } });
if (!res.valid) { /* ... */ }   // TRẢ VỀ {valid:false}, KHÔNG throw. `if (await verify(...))` luôn truthy.
```

**404 hoá đúng 5 route** (không phải 6 — `/verify` không được mount, đã 404 sẵn):
`POST /api/auth/api-key/create` · `GET …/get` · `GET …/list` · `POST …/update` · `POST …/delete`

**Xác nhận tốt**: key lưu SHA-256 → base64url-unpadded, **không bao giờ plaintext**;
verify là **một lookup equality có index** (`findOne` trên `apikey.key`, `index: true`) — **không scan bảng**.
Lý lẽ thay thế mcphub vẫn đứng vững.

Bẫy khác đã đo: fail permission trả **401 `KEY_NOT_FOUND`, không phải 403**, và better-auth log
`ERROR [Better Auth]: Failed to validate API key` ra stderr — **đừng page theo dòng log đó**, và
**đừng suy ra "key không tồn tại"** từ code đó. Cột chủ sở hữu là **`referenceId`**, không phải `userId`.
`key` chỉ `index: true`, **không `unique`** — DB không chặn trùng hash.

### 14.3 Transport downstream — hai ràng buộc bắt buộc, một trong đó là resource leak

Canh bạc stateless **sống**: `initialize` không nhả `Mcp-Session-Id`, POST tiếp theo không session vẫn chạy,
client SDK thật hài lòng với `sessionId === undefined`. Nhưng:

**1. Transport stateless là DÙNG MỘT LẦN.** `webStandardStreamableHttp.js:172-176` throw
`Stateless transport cannot be reused across requests` ở `handleRequest` **thứ hai**.
Và nó **không phải chuyện lý thuyết** — nó giết cả cú bắt tay của **một** client, vì
POST `notifications/initialized` đã là request **thứ 2** (đo được: POST 1 → 200, POST 2 → **500**).

→ Handler `/mcp` phải dựng **`Server` mới VÀ transport mới BÊN TRONG mỗi request**, `await server.connect(transport)` ở đó,
rồi tear down. Cache **descriptor của tool**, không cache object `Server`.

> Ví dụ Hono trong chính `.d.ts` của SDK (`app.all('/mcp', c => transport.handleRequest(c.req.raw))`
> trên một transport ở module scope) là **sai hình dạng và sẽ throw ở request thứ 2**.

**2. Gateway phải tự trả lời GET — transport KHÔNG 405.** Ở chế độ stateless, GET vào transport trả
**200 `text/event-stream` và treo vô hạn** (`js:220-250` — `validateSession` là no-op nên không gì reject).
`app.all('/mcp', …)` vào transport là **rò tài nguyên**.

→ `app.post('/mcp', …)` cho transport, cộng một route anh em `app.all('/mcp', …)` trả `405 Allow: POST`.
Client SDK xử lý 405 đó đúng (đã đo: `client transport errors: none`). DELETE stateless trả 200 body rỗng — cũng phải tự sở hữu.

**3. `enableJsonResponse: TRUE` là mặc định của MCPRouter, không phải `false`** (spec cũ ghi ngược).
Đó là chế độ **duy nhất** đóng được transport sau khi `handleRequest` trả về — đo được **0 cặp chưa đóng**.
Với `false`: đóng ngay sau call thì giết stream đang sống (`MCP error -32001: Request timed out`),
không đóng thì transport **vĩnh viễn chưa đóng, `onclose` không bao giờ bắn** (4 cái rò trong một phiên test).
Chỉ lật sang `false` khi downstream thật sự cần progress notification giữa call, và phải kèm hook dọn dẹp
mà transport hiện **không** phơi ra.

Thêm: `Accept: application/json` **một mình bị 406** kể cả khi `enableJsonResponse: true` —
transport đòi **cả hai** `application/json` và `text/event-stream`. Client không phải SDK mà MCPRouter proxy hộ phải gửi cả hai.

### 14.4 stdio — subclass 45 dòng, không phải viết lại transport

`stderr: 'pipe'` ✅ · `getDefaultEnvironment()` ✅ · **`detached` ❌ không tồn tại**.

Object option spawn ở `stdio.js:65-75` **hardcode, không có hook override**, và key thừa truyền vào constructor
bị **bỏ im lặng** (đã đo: probe `detached:true, shell:true` vẫn chung process group và vẫn spawn `node`, không phải `/bin/sh`).
`process.kill(-pid)` trên child spawn kiểu stock **throw ESRCH**.

SDK có phơi child (`transport.pid`, và `transport._process` là `ChildProcess` thật lúc chạy vì `private` của TS bị erase) —
nhưng **phơi ra là chưa đủ**: process group phải lập **lúc spawn**, và Node **không có `setpgid` hậu-spawn**.

→ **Subclass override đúng `start()` và `close()` (~45 LOC)**. Dùng lại framing, `ReadBuffer`, `send()`,
getter `stderr`/`pid` của SDK. Không phải viết lại transport, nằm trong ngân sách fallback 10–50 LOC.
`tree-kill` và `procps` **vẫn bỏ được**.

Và subclass còn đáng giá ngoài chuyện bỏ dependency: **`close()` stock rò grandchild** (đã đo: `sleep 300` sống sót qua `close()`).
Với gateway giám sát upstream kiểu `npx` — vốn thường xuyên fork — đây là rò process thật.

Bẫy đã đo:
- **`transport.stderr` là `PassThrough` dựng trong CONSTRUCTOR** (`stdio.js:53-55`) → non-null **trước** `start()`.
  Gắn listener ngay sau `new StdioClientTransport(...)` là **bắt được cả output lúc boot của child**. Thứ tự này rơi về phía tốt.
- Getter `stderr` chỉ là PassThrough khi truyền **đúng** `'pipe'` hoặc `'overlapped'`. Bỏ option thì trả `null` cả trước lẫn sau start.
- `start()` đã tự merge `{...getDefaultEnvironment(), ...env}` — nhưng **không** merge `process.env` đầy đủ:
  **chỉ 6 biến sống sót trên POSIX** (`HOME LOGNAME PATH SHELL TERM USER`).
- `getDefaultEnvironment()` **xoá mọi biến có giá trị bắt đầu bằng `()`** (phòng Shellshock, `stdio.js:35-38`).
  Đã đo: `PATH='() { evil; }'` làm PATH **biến mất hoàn toàn** khỏi kết quả — bị drop, không phải sanitize.
- SDK spawn qua **`cross-spawn`**, không phải `node:child_process`. Subclass đổi sang `spawn` của Node —
  ổn trên POSIX nhưng **mất xử lý shim `.cmd`/`.bat` của Windows**. Từ Node ≥18.20/20.12 (CVE-2024-27980)
  `spawn` từ chối `.cmd` khi không `shell:true`. Khớp với §15: Windows đã hoãn.
- `detached: true` **không miễn phí**: child không còn nhận Ctrl-C/SIGINT cùng parent, MCPRouter **thành nơi duy nhất reap nó**.
  Router bị SIGKILL thì upstream detached **sống sót thành orphan**.

### 14.5 OAuth AS — `getMcpSession()` không tồn tại, thứ thay thế mạnh hơn

Không có hàm nào tên đó. Dùng **`requireMcpAuth(auth, handler, { resource, requiredScopes })`**,
đưa cho handler một `JWTPayload` **đã verify**: `aud`, `scope`, `sub`, `client_id`, `azp`, `jti`, `cnf`.

**Audience CÓ được phơi ra** → fallback *"MCPRouter phải tự introspect claim"* trong §5 **không cần nữa**. Zero LOC thêm.

**Mọi path trong spec cũ đều sai.** `/api/auth/mcp/...` không tồn tại. Hai bẫy cụ thể:

- **PRM phục vụ ở GỐC**: `/.well-known/oauth-protected-resource` — **không** dưới `/api/auth/`.
  Thứ đứng trước app **không được** giới hạn `/.well-known` theo basePath của auth.
- **AS metadata ở gốc trần là 404.** Client lấy nó ở `/.well-known/oauth-authorization-server/api/auth`
  (RFC 8414 path insertion) hoặc `/api/auth/.well-known/oauth-authorization-server`.
  Đúng RFC cho issuer `https://host/api/auth`, và client SDK đã pin **theo đúng** (`auth.js:552-586`) —
  nhưng **mọi assertion hay smoke test mong 200 ở gốc trần sẽ fail**.
  Muốn gốc trần chạy (client tự viết, docs dùng curl, client cũ): đặt `basePath: '/'` (đã verify 200),
  hoặc `jwt({ jwt: { issuer } })` — **một núm duy nhất** dịch issuer và mọi discovery path dẫn xuất.

**XOÁ route wildcard PRM đã định viết.** Plugin tự phục vụ **cả hai** `/.well-known/oauth-protected-resource`
**và** dạng path-inserted `/.well-known/oauth-protected-resource/mcp`, suy từ pathname của option `resource`
(`mcp/dist/index.mjs:192`). MCPRouter viết **zero** dòng PRM — chỉ forward `/.well-known/*` sang `auth.handler`.
**Một dòng Hono, không phải 10–50 LOC.**

**DCR: không phải đổi gì.** Tắt mặc định (`allowDynamicClientRegistration`), đúng như spec.

**Quyết định ngay mô hình audience đa server.** `mcp()` nhận **đúng một** `resource` canonical và
**không kết hợp được** với một `oauthProvider` thứ hai. Hub đứng trước N upstream: dùng **một**
`mcp({ resource: '<hub canonical>' })` cộng `resources: [...]` liệt kê định danh từng server.

### 14.6 SSRF — hai ghi chú cài đặt

Override `fetch` hoạt động trên cả hai transport. Nhưng:

1. **Đặt policy redirect BÊN TRONG `guardedFetch`, không phải trong `requestInit`** —
   bước mở GET-stream của StreamableHTTP **tự dựng init riêng và bỏ `requestInit`** (đo được: `redirect=(unset)`).
2. **Áp `redirect:'manual'` SAU khi spread init đến** — EventSource của SSE truyền `redirect:'follow'` (đo được).

### 14.7 Catalog — dùng `Server` low-level, không dùng `McpServer`

`McpServer.registerTool` **throw ngay lúc ĐĂNG KÝ** với JSON Schema thường:
`inputSchema must be a Zod schema or raw shape, received an unrecognized object` (`mcp.js:865-870`).

Và kể cả cho ăn Zod, nó **tái sinh** JSON Schema qua `toJsonSchemaCompat` — ra `$schema` draft-07,
chèn `maximum: 9007199254740991` vào integer, gắn regex 200 ký tự vào `format: date-time`.
**Không gì sống sót nguyên vẹn qua API high-level.**

→ Low-level `Server` + `setRequestHandler(ListToolsRequestSchema, …)`. Đã đo giữ nguyên:
`$defs` · `$ref` · `oneOf` · `additionalProperties` · `title` · **cả vendor extension `x-openapi-operation-id`**
(nhờ `.catchall(z.unknown())` ở `types.js:1229-1249` và `z.custom` passthrough ở `types.js:13`).

Thêm phần thưởng: `Server` **không validate gì** ở `tools/call` — gateway forward object thô đúng như thiết kế,
**không cần tầng chuyển đổi Zod nào trong catalog**.

Ràng buộc đã đo: `inputSchema` gốc **phải** là `type: "object"` (root khác bị reject `$ZodError`),
và **không được thiếu** `inputSchema`. Thứ tự key **không** được bảo toàn qua parse phía client —
nên **hash định nghĩa ở §11.2 phải sort key**, đúng như đã thiết kế.

### 14.8 Điều spike 8 KHÔNG chứng minh

Đã kiểm: client của chính SDK. Chưa kiểm: **Claude Desktop, Claude Code, Cursor, VS Code, Continue** —
các client thật, mà một số có thể có hành vi riêng ngoài SDK.

Phép thử rẻ nhất, chạy **trước khi P1 đóng**: dựng gateway local, rồi dán vào client thật:

```jsonc
{ "mcpServers": { "mcprouter": {
    "type": "http", "url": "http://127.0.0.1:3000/mcp",
    "headers": { "Authorization": "Bearer mcpr_…" } } } }
```

Quan sát: client có GET để mở stream không, có DELETE lúc đóng không, có phàn nàn khi thiếu `Mcp-Session-Id` không.
Hedge `MCP_EMIT_SESSION_ID` (§2) tốn 10 LOC nếu cần.

---

## 15. Danh sách hoãn, kèm điều kiện kích hoạt

| Hoãn | Làm khi |
|---|---|
| Modern era `2026-07-28` | SDK ship `LATEST_PROTOCOL_VERSION >= '2026-07-28'` |
| stdio on-demand/ngủ với idle shutdown | Một deployment báo >20 stdio server, hoặc RSS child nhàn rỗi vượt 2 GB. State `idle` và `ensureReady()` **đã ship ở v1** vì reconnect và boot race cần chúng sẵn |
| Credential per-user cho stdio (một process mỗi principal) | Server đầu tiên cần nó xuất hiện. **Trần hôm nay**: config layer phải **TỪ CHỐI** `credentialMode:'per-user'` trên `type:'stdio'` cho tới khi có, thay vì âm thầm làm sai |
| Catalog per-user | Tìm thấy một server thật mà `tools/list` phụ thuộc token của caller |
| `subscriptions/listen` đẩy notification xuống client | SDK ship modern era **VÀ** có người báo tool list bị cũ. **Không bao giờ** dựng legacy GET stream để giải quyết |
| Sampling / elicitation / roots | MRTR (SEP-2322) vào SDK. Dựng bản `2025-11-25` bắt core phải biết danh tính client downstream — vi phạm thẳng luật no-session |
| `.mcpb` upload | Một team cần chạy server nội bộ không publish ở registry nào **VÀ** config stdio dán tay không diễn đạt được. Khi làm: verify `fileSha256` trước khi giải nén, chặn zip-slip bằng `startsWith(destDir + sep)`, cap size per-entry **và** tổng, giải vào `${DATA_DIR}/packages/<uuid>` — **uuid, không bao giờ path dẫn xuất từ tên** — rồi `rename` atomic |
| OpenAPI export + REST tool-exec facade | Có người thật sự cần OpenWebUI. Nó là **đường thực thi thứ hai phải nhân bản mọi check** — đúng lý do mcphub có hai khối ~150 dòng gần trùng nhau |
| `/.well-known/mcp-marketplace` public | MCPRouter được deploy làm hub cộng đồng, không phải gateway của team. Khi đó sao chép mcphub **chính xác**: tắt thì trả 404 chứ không 401, để surface không dò được |
| Swagger 2.0 import | User đầu tiên chạm message từ chối. Nâng cấp 3 dòng với `swagger2openapi` |
| multipart/form-data trong OpenAPI import | Một API nội bộ cần thiết chỉ nhận upload. Hôm nay nó nằm trong `skipped[]` kèm lý do, nên **nhu cầu nhìn thấy được trước khi viết code** |
| Cookie jar / Set-Cookie replay | Một API thật sự không lái được bằng token tĩnh. **Phải** dựng per-principal ngay từ ngày đầu — một jar dùng chung trên gateway nhiều người là **rò session chéo user**, không phải tính năng |
| Log persist / shipping (Loki, OTLP logs) | Operator hỏi cách search log từ trước lần restart gần nhất. Khi đó trỏ UI vào Loki; **không** phình ring |
| Histogram latency per-tool ở Prometheus | **Không bao giờ** cho registry mặc định. Nếu buộc phải alert per-tool, dùng recording rule trên summary dẫn xuất từ audit, hoặc allowlist ≤20 tên tool |
| Partition RANGE theo tháng cho `audit_event` | Bảng vượt ~50M dòng hoặc DELETE hằng đêm quá 60s |
| Rate limit cho principal dùng OAuth token | `mcp_rejected_total{reason="busy"}` khác không đáng kể với `credential_kind=oauth` |
| State concurrency/rate phân tán (advisory lock hoặc Redis) | Chạy nhiều hơn một process. v1 tường minh là **một** process; comment ở semaphore ghi rõ trần này |
| Helm chart / K8s manifest | User chạy nhiều hơn một replica. Tầng dữ liệu đã replica-safe, nên đây là đóng gói + một annotation session affinity |
| Playwright e2e cho SPA | Lần regression UI thứ hai mà component test không bắt được |
| Hỗ trợ Windows cho stdio upstream và CLI | Một user thật yêu cầu. Ngữ nghĩa kill process-group khác hẳn, cần implementation thật chứ không phải shim |

---

## 16. Rủi ro đã biết

| Rủi ro | Giảm nhẹ |
|---|---|
| **Canh bạc stateless.** Client thật bắt buộc cần `Mcp-Session-Id` hoặc standalone GET stream → ta trông như hỏng | Ma trận tương thích chạy **trước khi P1 đóng**; hedge session trang trí 10 LOC. Xác suất đánh giá thấp: client SDK chịu được 405 trên GET, và spec cho phép server stateless tường minh |
| **Phục vụ catalog stale lúc reconnect** khiến một tool được list mà đã không còn ở upstream | Trung thực, nhưng đổi bề mặt lỗi. UI **phải** hiện state `stale` màu amber, nếu không operator sẽ đọc thành tool hỏng |
| **Fan-out kết nối per-user**: 20 user × 5 server per-user = 100 kết nối upstream | Evict 10 phút chặn trong thực tế. Nếu cắn: semaphore riêng, rộng hơn, cho per-user lease |
| **Separator `__` là cửa một chiều** khi client đã cache tên tool | Assert lúc boot: không server name nào chứa `__`, từ chối start kèm message nêu tên vi phạm. Rẻ, phải ship |
| **Tool bị drop vì quá khổ** (schema > 256 KB, tên chiếu > 128 ký tự) im lặng với client | Cảnh báo `upstream:log` **phải** hiện ở panel server detail. Đây là phụ thuộc thật vào subsystem web |
| **TOCTOU DNS-rebinding** giữa `assertSafeUrl` và connect thật | Trần đã ghi. Chấp nhận được khi URL server do admin cung cấp; **phải đóng** trước khi bất kỳ URL không-admin hoặc do marketplace lái tới được `createTransport` |
| `UpstreamServer` tách theo credential fingerprint khiến `status()` phải **gộp** | Dashboard hiện **một** dòng per server cấu hình với số kết nối per-user — bỏ qua bước gộp thì deployment 20 user render 100 dòng status và console, thứ ta lấy làm khác biệt, trông tệ hơn mcphub |
| **Chuỗi migration better-auth dịch chuyển giữa các minor** | Gate `git diff --exit-code` bắt được drift, nhưng gánh nặng review trên bảng ta không sở hữu là thật |
| `CREATE EXTENSION vector` cần superuser | `IF NOT EXISTS` + `MIGRATE_ON_BOOT=false`. **Thứ đầu tiên** một operator enterprise vấp phải |
| **Đổi model embedding sang chiều khác** cần ALTER viết tay + rebuild index | Boot **từ chối start** thay vì xếp hạng sai. Ồn ào, nhưng là sự kiện downtime trừ khi operator dùng Matryoshka truncation |
| **Ring SSE và resume Last-Event-ID giả định một process** | Replica thứ hai chia đôi stream, mỗi browser thấy một nửa event, **không có lỗi nhìn thấy được** |
| **Triage tính p95 thật trên `audit_event` thô** — thiếu index `(server, started_at desc)` hoặc nới cửa sổ quá 15m thì tụt xuống seq scan | Đúng dưới tải mà nó sinh ra để chẩn đoán |
| **Audit ghi bất đồng bộ** — call thành công mà mất dòng audit nếu process bị SIGKILL trong cửa sổ 250 ms | SIGTERM flush; SIGKILL và OOM không. Với deployment compliance đây là đánh đổi sai; đường nâng cấp là thay đổi thật |
| **`metadata` làm mặc định** sẽ đẻ ra ít nhất một sự cố mà operator cần argument nhưng chỉ có tên khoá | Override `full` per-server tồn tại đúng cho việc đó, nhưng **phải bật TRƯỚC sự cố**. RequestDrawer có affordance một-click "bật full payload cho server này" với retention 7 ngày ghi ngay tại chỗ |
| **Registry chính thức còn pre-1.0**, shape response đổi được | zod `.loose()` ở biên + cache stale → hỏng upstream suy biến thành "catalog không khả dụng, thêm tay vẫn chạy". Alert là `catalog_fetch_total{result="error"}` |
| **`$ref` + `$defs` trong tool inputSchema** có thể làm rối một MCP client flatten JSON Schema ngây thơ | **Canh bạc lớn nhất của thiết kế này.** Hoãn sẵn cờ per-server `dereferenceSchemas: true` (~20 LOC); rủi ro là ta biết qua báo cáo user chứ không qua test |
| **Image không có biến thể INSTALL_EXT** → upstream cần runtime ta không ship (Rust, Java, Go, browser) không chạy được trong container | Câu trả lời đã ghi: chạy chúng làm sibling container và đăng ký làm upstream streamable-http — vốn cũng là kiến trúc an toàn hơn |
| **Guardrail phiền thì bị tắt, và tắt rồi thì bảo vệ zero.** Đây là rủi ro lớn nhất của cả §11 | Mặc định phải sống được: TOFU gấp vào bước enable · `observe` mode để roll out · chặn vì integrity **được audit và đếm** nên trả lời được "guardrail có đang làm hỏng agent không" · deny **huỷ được** trong cooldown · explain drawer cho mọi quyết định |
| **Quét egress chỉ thật với secret TA quản lý.** Nó không phải DLP | Ghi rõ trong docs và trong helper text UI. Mọi thứ rộng hơn (PII, hình dạng secret, injection) đã bị từ chối tường minh ở §11.6 là **diễn**, không phải hoãn |
| **Nhãn provenance chỉ giúp client nào CHỌN tôn trọng nó** | Hôm nay chưa client nào. Vẫn ship vì nó 5 dòng và là phần một host tương lai sẽ key vào. Phần đắt (wrap + nonce) đã cắt |
| **Hold 55s vẫn có thể gần như luôn bị bỏ rơi** | Nếu đo được là vậy, **xoá hold** và ship retry-sau-duyệt + pre-approval: nhỏ hơn ~300 LOC. Ticket đã làm điều đó khả thi mà không mất tính năng |
| **`$smart` là đường vòng qua guardrail nếu `call_tool` không gọi `guardedCall`** | Viết đúng từ P5, không đi dây lại ở P7. Test byte-identical giữa gọi trực tiếp và gọi qua `$smart` |
| **Job e2e chậm dần rồi có người comment nó đi** — **chính xác** là cách job của mcphub chết | e2e chạy `createApp` in-process (~90s, không phải ~8min) · `timeout-minutes: 8` biến sự phình thành failure thay vì một khoản thuế · CODEOWNERS trên `/.github/` |

---

## 17. Ghi chú cho người review

Ba chỗ tôi cho là đáng tranh luận nhất, theo thứ tự:

1. **Stateless downstream ở v1** (§2). Đây là quyết định đắt nhất nếu sai, và rẻ nhất nếu đúng.
   Toàn bộ §4.2 phụ thuộc vào nó. Spike #8 phải chạy trước khi P1 đóng.
2. **Một trục phân quyền** (§5.3). Đã chốt, nhưng hệ quả là không có "server riêng của tôi" —
   mọi server là của team, riêng tư đạt được bằng credential binding per-user. Nếu team cần server thật sự riêng,
   đây là chỗ phải mở lại, và mở lại **sau** thì đắt hơn mở lại **bây giờ**.
3. **Không dereference OpenAPI spec** (§10). Tiết kiệm một dependency nặng và bịt một lỗ SSRF,
   nhưng đẩy `$ref`/`$defs` ra tới client. Đây là canh bạc ta không test hết được.
4. **Guardrail đẩy dự án từ 12.5 lên 17.0 dev-week** (§11.10) — tăng 36%. Nếu lịch là ràng buộc cứng,
   thứ tự cắt là: approval (P7, −1.5w, giữ policy `deny` thuần) → UI review queue (P3, −1.5w, chỉ còn CLI)
   → policy engine (P2, −0.75w). **Chống rug-pull (§11.2) là thứ cuối cùng được cắt**: nó rẻ nhất,
   không có bài toán false positive, và là cơ chế duy nhất chỉ gateway làm được.
5. **`guardrails.integrity` mặc định `enforce`** (§11.2). Guardrail ship ở trạng thái tắt là diễn —
   nhưng nghĩa là một cài đặt mới chặn mọi tool xuất hiện sau khi server đã enable, cho tới khi có người click.
   `observe` tồn tại cho team muốn roll out êm. Nếu bạn muốn ngược lại, đây là chỗ đổi.

Nguyên liệu đầy đủ của từng subsystem: `docs/superpowers/designs/*.json` —
`engine` · `surface` · `auth` · `schema` · `observability` · `routing` · `catalog` · `designsystem` · `screens` · `platform`
· `guardrails-integrity` · `guardrails-approval` và hai file `-critique` tương ứng.

Hai file critique guardrail đáng đọc nguyên văn trước khi implement §11: cả hai cho verdict `needs-revision`
với **25 lỗ bảo mật, trong đó 2 CRITICAL**, và §11 là bản đã áp dụng toàn bộ bản vá — không phải bản thiết kế gốc.
