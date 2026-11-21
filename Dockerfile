# ==============================================================================
# Cairn Container Image
# Multi-stage build for a minimal, secure, cross-platform production image.
# ==============================================================================

# --- Stage 1: Build & Package ---
# Pin the builder to the native build platform. The build only produces portable
# JavaScript (verified by check:portable), so compiling once on the native arch
# avoids running npm/tsc under QEMU emulation for the arm64 image — which can
# otherwise stall the multi-arch build for hours.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

# Install dependencies needed for build
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy sources and scripts
COPY src/ ./src/
COPY web/ ./web/
COPY scripts/ ./scripts/

# Compile TypeScript and verify portability
RUN npm run build && node scripts/check-portable.mjs

# Prune development dependencies
RUN npm prune --omit=dev

# --- Stage 2: Production Runtime ---
FROM node:22-alpine AS runner

WORKDIR /app

LABEL org.opencontainers.image.title="Cairn" \
      org.opencontainers.image.description="Shared graph memory for coding agents" \
      org.opencontainers.image.licenses="MIT"

# Set runtime environment
ENV NODE_ENV=production \
    PORT=4242 \
    HOST=0.0.0.0 \
    CAIRN_VAULT=/data/.cairn

# Create data directory with permissions for the non-root 'node' user
RUN mkdir -p /data && chown -R node:node /data /app

# Copy production artifacts from builder
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules/
COPY --from=builder --chown=node:node /app/dist ./dist/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node docs/ ./docs/
COPY --chown=node:node rules/ ./rules/
COPY --chown=node:node skills/ ./skills/
COPY --chown=node:node README.md LICENSE ./

# Run as non-root user
USER node

# Persistent vault storage
VOLUME ["/data"]

EXPOSE 4242

# Health check probing the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 4242) + '/api/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start", "--vault", "/data/.cairn", "--host", "0.0.0.0", "--allow-remote", "--no-open"]
