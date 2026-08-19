# Multi-stage build: compile TypeScript to dist/ in the first stage, then
# ship only production dependencies + compiled output in the final image.
FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# --- production stage ---
FROM node:24-slim AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]
