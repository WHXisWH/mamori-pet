# syntax=docker/dockerfile:1.7
# ビルドコンテキストはリポジトリのルート: docker build -f apps/child-web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS build
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_VOICE_WS_URL
ARG NEXT_PUBLIC_CHILD_APP_URL
ARG NEXT_PUBLIC_GUARDIAN_APP_URL
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_VAPID_KEY
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_CHAT_MODE=api \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_VOICE_WS_URL=${NEXT_PUBLIC_VOICE_WS_URL} \
    NEXT_PUBLIC_CHILD_APP_URL=${NEXT_PUBLIC_CHILD_APP_URL} \
    NEXT_PUBLIC_GUARDIAN_APP_URL=${NEXT_PUBLIC_GUARDIAN_APP_URL} \
    NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY} \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID} \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN} \
    NEXT_PUBLIC_FIREBASE_VAPID_KEY=${NEXT_PUBLIC_FIREBASE_VAPID_KEY}
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@ijime/child-web...

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/child-web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/child-web/.next/static ./apps/child-web/.next/static
COPY --from=build --chown=node:node /repo/apps/child-web/public ./apps/child-web/public
USER node
EXPOSE 8080
CMD ["node", "apps/child-web/server.js"]
