# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    chromium \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer needs to know where Chromium is
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY docs/ ./docs/

# Rebuild native modules (better-sqlite3) in production image
RUN npm rebuild better-sqlite3

# Create data and logs directories
RUN mkdir -p data logs config

# Non-root user for security
RUN groupadd -r agency && useradd -r -g agency -d /app agency
RUN chown -R agency:agency /app
USER agency

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
