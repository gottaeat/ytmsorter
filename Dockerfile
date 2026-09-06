FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY src ./src
COPY public ./public
COPY tests ./tests
COPY scripts ./scripts
RUN npm run check

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime

LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
