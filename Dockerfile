FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY collector/package.json collector/
COPY publisher/package.json publisher/
COPY --chown=node:node site/package.json site/
RUN npm ci --omit=dev
COPY collector collector
COPY publisher publisher
COPY --chown=node:node site site
# Astro writes site/.astro and the Vite cache. Make them writable for any uid (HOST_UID).
RUN mkdir -p site/.astro site/node_modules/.astro node_modules/.vite && chmod -R a+rwX site/.astro site/node_modules/.astro node_modules/.vite
RUN mkdir /data && chown node:node /data
ENV DATA_ROOT=/data
# HOST_UID may have no passwd entry, so HOME=/ and tools write under /. /tmp is writable by any uid.
ENV HOME=/tmp
USER node
