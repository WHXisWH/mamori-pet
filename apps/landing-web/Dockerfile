# syntax=docker/dockerfile:1.7
# ビルドコンテキストはリポジトリのルート: docker build -f apps/landing-web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS build
ARG NEXT_PUBLIC_CHILD_APP_URL
ARG NEXT_PUBLIC_GUARDIAN_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_CHILD_APP_URL=${NEXT_PUBLIC_CHILD_APP_URL} \
    NEXT_PUBLIC_GUARDIAN_APP_URL=${NEXT_PUBLIC_GUARDIAN_APP_URL}
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@ijime/landing-web...

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/landing-web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/landing-web/.next/static ./apps/landing-web/.next/static
COPY --from=build --chown=node:node /repo/apps/landing-web/public ./apps/landing-web/public
USER node
EXPOSE 8080
CMD ["node", "apps/landing-web/server.js"]
