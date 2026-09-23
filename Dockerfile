# ==========================================
# Stage 1: Build stage
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency definitions
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for TypeScript build)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Compile TypeScript to JavaScript in /app/dist
RUN npm run build

# ==========================================
# Stage 2: Production runner stage
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

# Set default production environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    MCP_TRANSPORT=sse \
    GLPI_ALLOWED_UPLOAD_DIR=/app/uploads

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled code from builder
COPY --from=builder /app/dist ./dist

# Create uploads sandbox directory and assign ownership to non-root 'node' user
RUN mkdir -p /app/uploads && chown -R node:node /app

# Run as unprivileged user for security
USER node

# Expose HTTP/SSE port
EXPOSE 3000

# Container healthcheck for Easypanel / Traefik / Docker
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Start MCP Server
CMD ["node", "dist/index.js"]
