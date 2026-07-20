# Temporary demo container for the Threadbot Runware pipeline.
# Builds the TS and runs the HTTP wrapper (src/server.ts). Cloud Run injects PORT.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Cloud Run sets PORT (default 8080); the server binds 0.0.0.0.
EXPOSE 8080
CMD ["node", "dist/server.js"]
