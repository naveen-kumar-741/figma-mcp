# Figma MCP Server

> **Model Context Protocol (MCP) server for Figma** — Access Figma files, components, design tokens, and assets through a standardized MCP interface.

[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-SDK%20v2-purple.svg)](https://modelcontextprotocol.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-blue.svg)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-53%20passing-brightgreen.svg)](#testing)

---

## 🚀 Features

| Feature | Description |
|---------|-------------|
| **11 MCP Tools** | Complete Figma API coverage: files, nodes, components, styles, screenshots, search |
| **Real Figma API** | Direct integration with Figma REST API (not mock data) |
| **Authentication** | Personal Access Token + optional API key/IP allowlist for HTTP server |
| **Rate Limiting** | Client-side (30 req/s) + server-side (10 req/s per client) |
| **ETag Caching** | 5-min TTL, 304 Not Modified support, reduces API calls by ~80% |
| **Structured Logging** | pino JSON + pretty dev mode, configurable levels |
| **Request Tracing** | X-Request-ID correlation across all logs |
| **MCP Protocol Logging** | Debug-level JSON-RPC request/response visibility |
| **Docker Ready** | Multi-stage build, non-root, health checks, resource limits |
| **53 Tests** | Unit + integration tests with mocked Figma API |

---

## 📦 Quick Start

### Prerequisites

- Node.js 22+
- Figma Personal Access Token ([create one](https://www.figma.com/developers/api#access-tokens))

### Local Development

```bash
# Clone and install
git clone <your-repo>
cd figma-mcp
npm install

# Configure
cp .env.example .env
# Edit .env with your FIGMA_ACCESS_TOKEN

# Build and run
npm run build
npm start
```

### With Docker

```bash
# Configure
cp .env.example .env
# Edit .env with your FIGMA_ACCESS_TOKEN

# Build and run
docker compose up -d --build

# Check health
curl http://localhost:3000/health
```

---

## ⚙️ Configuration

All configuration via environment variables (see `.env.example`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIGMA_ACCESS_TOKEN` | ✅ | - | Figma Personal Access Token |
| `MCP_API_KEY` | ❌ | - | Enable HTTP auth (Bearer or X-API-Key) |
| `MCP_ALLOWED_IPS` | ❌ | - | Comma-separated IP allowlist (CIDR supported) |
| `MCP_RATE_LIMIT_RPS` | ❌ | 10 | Server-side requests/second per client |
| `MCP_RATE_LIMIT_BURST` | ❌ | 10 | Server-side burst capacity |
| `MCP_LOG_LEVEL` | ❌ | info | `debug` \| `info` \| `warn` \| `error` |
| `FIGMA_LOG_LEVEL` | ❌ | info | Figma client log level |
| `PORT` | ❌ | 3000 | HTTP server port |
| `HOST` | ❌ | 127.0.0.1 | HTTP server host |
| `MCP_PATH` | ❌ | /mcp | MCP endpoint path |

---

## 🔧 MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `figma_sync` | Full file sync with stats | `fileKey`, `mode?`, `branchName?` |
| `figma_list_files` | List files in project/team | `projectId?`, `teamId?` |
| `figma_get_file_overview` | File metadata + pages | `fileKey`, `version?`, `branchData?` |
| `figma_get_page_context` | Page node tree | `fileKey`, `pageId`, `depth?`, `includeStyles?` |
| `figma_get_node_context` | Specific node details | `fileKey`, `nodeId`, `depth?`, `includeStyles?`, `includeChildren?` |
| `figma_search_design` | Search nodes by name/type | `query`, `fileKey?`, `type?`, `limit?` |
| `figma_get_components` | Component definitions | `fileKey`, `includeVariants?`, `onlyPublished?` |
| `figma_get_design_tokens` | Styles as design tokens | `fileKey`, `tokenTypes?`, `format?` (json/css/scss/figma) |
| `figma_get_screenshot` | Node screenshots | `fileKey`, `selection[]`, `format?`, `scale?`, `backgroundColor?` |
| `figma_get_assets` | Export assets | `fileKey`, `format?`, `scale?`, `ids?` |
| `figma_get_sync_status` | File version info | `fileKey`, `includeHistory?`, `limit?` |
| `figma_get_rate_limit_status` | Local + Figma rate limits | - |
| `figma_get_cache_status` | ETag cache statistics | - |
| `figma_clear_cache` | Clear ETag cache | - |

---

## 📡 Usage Examples

### List Tools

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Get File Overview

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"figma_get_file_overview","arguments":{"fileKey":"YOUR_FILE_KEY"}},"id":1}'
```

### Search Components

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"figma_search_design","arguments":{"query":"button","fileKey":"YOUR_FILE_KEY","type":"component","limit":10}},"id":1}'
```

### Get Design Tokens (CSS)

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"figma_get_design_tokens","arguments":{"fileKey":"YOUR_FILE_KEY","format":"css"}},"id":1}'
```

### With Authentication

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"figma_get_file_overview","arguments":{"fileKey":"YOUR_FILE_KEY"}},"id":1}'
```

---

## 🏥 Health & Monitoring

| Endpoint | Auth | Rate Limited | Description |
|----------|------|--------------|-------------|
| `GET /health` | ❌ | ❌ | Container health check |
| `GET /rate-limit-status` | ✅* | ❌ | Per-client rate limit status |
| `POST /mcp` | ✅* | ✅ | MCP protocol endpoint |

*Only if `MCP_API_KEY` or `MCP_ALLOWED_IPS` configured.

### Health Check Response

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600.5,
  "version": "1.0.0"
}
```

---

## 🐳 Docker Deployment

### docker-compose.yml

```yaml
services:
  figma-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - FIGMA_ACCESS_TOKEN=${FIGMA_ACCESS_TOKEN}
      - MCP_API_KEY=${MCP_API_KEY}
      - MCP_LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      start_period: 10s
```

### Production Build

```bash
# Multi-stage build (100MB → ~50MB final)
docker build -t figma-mcp:latest .

# Run with resource limits
docker run -d \
  --name figma-mcp \
  -p 3000:3000 \
  -e FIGMA_ACCESS_TOKEN=figd_xxx \
  -e MCP_API_KEY=secret \
  --cpus=0.5 \
  --memory=512m \
  figma-mcp:latest
```

---

## 🧪 Testing

```bash
# Run all tests (53 tests)
npm test

# Watch mode
npm run test:watch

# Coverage
npm test -- --coverage
```

### Test Structure

```
tests/
├── token-bucket.test.ts      # Rate limiter core
├── etag-cache.test.ts        # ETag cache behavior
├── figma-client.test.ts      # Figma API client (mocked fetch)
├── server-rate-limiter.test.ts # Per-client rate limiting
└── handlers.test.ts          # MCP tool integration scenarios
```

---

## 📁 Project Structure

```
figma-mcp/
├── src/
│   ├── index.ts              # MCP HTTP server + 11 tools
│   ├── figma-client.ts       # Figma API client (TokenBucket, ETagCache)
│   └── server-rate-limiter.ts # Per-client rate limiter
├── tests/                    # 53 tests across 5 suites
├── dist/                     # Compiled output
├── Dockerfile                # Multi-stage build
├── docker-compose.yml        # Production deployment
├── .env.example              # Configuration template
├── .dockerignore             # Build context exclusions
├── jest.config.cjs           # Jest ESM config
├── tsconfig.json             # TypeScript config
└── package.json
```

---

## 🔒 Security

- **Non-root Docker user** (UID 1001)
- **No secrets in image** — all via env vars
- **Optional API key auth** for HTTP endpoint
- **IP allowlist** support
- **Rate limiting** prevents abuse
- **Input validation** via Zod v4 schemas

---

## 📝 License

MIT License — feel free to use in your projects.

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure `npm test` and `npm run build` pass
5. Submit a PR

---

## 🔗 Related

- [Figma REST API Docs](https://www.figma.com/developers/api)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)