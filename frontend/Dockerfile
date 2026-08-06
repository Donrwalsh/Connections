# --- build stage ---
# Multi-stage build: Vite bundles the app into static assets in the first
# stage; the second stage serves those from a minimal nginx image.
FROM node:24-alpine AS build

WORKDIR /app

# VITE_API_URL is baked into the bundle at build time. Override at image
# build time with `--build-arg VITE_API_URL=https://api.example.com`.
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL

# Install deps before copying source so this layer is cached across rebuilds.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- serve stage ---
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
