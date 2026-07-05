# Threadbot backend — real generation API (/generate, /preview, /webhooks/stripe).
FROM node:22-slim

# sharp runtime deps are bundled in its prebuilt binaries on debian-slim.
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY data ./data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run via tsx (no build step needed). --dns-result-order=ipv4first avoids broken
# IPv6 egress on the host (manifests as undici "Premature close" to OpenAI/Printful).
CMD ["node", "--dns-result-order=ipv4first", "--import", "tsx", "src/server.ts"]
