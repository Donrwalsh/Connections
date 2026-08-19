# Multi-stage build: compile TypeScript to dist/ in the first stage, then
# ship only production dependencies + compiled output in the final image.
# Serves both the backend API (dist/main.js) and the worker process
# (dist/worker.js) — the two Coolify services override CMD to pick one.
FROM node:24-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- production stage ---
FROM node:24-slim AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/main.js"]
