# ── Frontend Dockerfile ───────────────────────────────────────────────────────
# Stage 1 — build: compiles the React app into a static bundle
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first (maximises Docker layer cache — only re-runs npm install
# if package.json or package-lock.json actually change)
COPY package.json package-lock.json ./

RUN npm install --no-audit --no-fund

# Copy source and build
COPY public/ ./public/
COPY src/ ./src/

# Build-time environment: inject the backend URL so the React bundle knows
# where to point. Override with --build-arg at docker build time if needed.
ARG REACT_APP_API_URL=http://localhost:8000
ENV REACT_APP_API_URL=$REACT_APP_API_URL

RUN npm run build


# Stage 2 — serve: host the static bundle via nginx (tiny, production-grade)
FROM nginx:1.27-alpine AS runtime

# Remove the default nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy the React production build from the builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Custom nginx config: SPA routing (all paths → index.html),
# gzip compression, and sensible cache-control headers
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx runs in foreground (daemon off is the default for the official image)
CMD ["nginx", "-g", "daemon off;"]
