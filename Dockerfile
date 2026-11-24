FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY collector/package.json collector/
COPY publisher/package.json publisher/
COPY --chown=node:node site/package.json site/
RUN npm ci --omit=dev
COPY collector collector
COPY publisher publisher
COPY updater updater
COPY --chown=node:node site site
COPY --chown=node:node docs/site-copy.md docs/glossary.md docs/
RUN mkdir /data /app/site-out && chown node:node /data /app/site-out
ENV DATA_ROOT=/data
USER node
