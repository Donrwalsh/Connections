# Multi-stage build: compile TypeScript to dist/ in the first stage, then
# ship only production dependencies + compiled output in the final image.
#
# Build context is the repo root (see docker-compose.yml / docker-compose.prod.yml)
# because this service depends on the workspace package packages/answer-grammar —
# Docker can't COPY from outside its build context, so root is the only context
# that can see both. npm gracefully ignores a workspaces glob entry (e.g.
# "backend") whose directory isn't present in this image, so only this
# service's own package.json + the shared package's are copied in.
FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY orchestrator/package.json ./orchestrator/
COPY packages/answer-grammar/package.json ./packages/answer-grammar/
RUN npm ci

COPY packages/answer-grammar ./packages/answer-grammar
COPY orchestrator ./orchestrator
RUN npm run build --workspace=packages/answer-grammar
RUN npm run build --workspace=orchestrator

# --- production stage ---
FROM node:24-slim AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY orchestrator/package.json ./orchestrator/
COPY packages/answer-grammar/package.json ./packages/answer-grammar/
RUN npm ci --omit=dev

COPY --from=build /app/packages/answer-grammar/dist ./packages/answer-grammar/dist
COPY --from=build /app/orchestrator/dist ./orchestrator/dist

WORKDIR /app/orchestrator
EXPOSE 3001
CMD ["node", "dist/index.js"]
