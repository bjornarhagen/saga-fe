FROM node:24-alpine AS dependencies
ENV ASTRO_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
COPY astro.config.mjs tsconfig.json ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts
RUN mkdir -p /var/lib/saga-fe && chown -R node:node /app /var/lib/saga-fe
USER node
EXPOSE 4321
CMD ["npm", "run", "dev"]

FROM development AS build
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1 HOST=0.0.0.0 PORT=4321 DATABASE_PATH=/data/saga-fe.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src/auth ./src/auth
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4321
CMD ["node", "dist/server/entry.mjs"]
