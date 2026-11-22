# =============================================================================
# Figma MCP Server - Multi-stage Docker Build
# =============================================================================

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY tests/ ./tests/

# Build TypeScript
RUN npm run build


# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S figma-mcp -u 1001 -G nodejs

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder --chown=figma-mcp:nodejs /app/dist ./dist

# Switch to non-root user
USER figma-mcp

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Environment variables (can be overridden at runtime)
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    MCP_PATH=/mcp \
    MCP_LOG_LEVEL=info \
    FIGMA_LOG_LEVEL=info

# Start server
CMD ["node", "dist/index.js"]