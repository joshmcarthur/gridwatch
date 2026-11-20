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
RUN mkdir /data && chown node:node /data
ENV DATA_ROOT=/data
USER node
