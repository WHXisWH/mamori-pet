# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile --filter "@ijime/api..."
RUN pnpm --filter "@ijime/api..." run build
RUN pnpm --filter "@ijime/api" deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8080 ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false
WORKDIR /app
COPY --from=build /out .
COPY kb ./kb
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
