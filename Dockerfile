FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY collector/package.json collector/
COPY publisher/package.json publisher/
COPY site/package.json site/
RUN npm ci --omit=dev
COPY collector collector
COPY publisher publisher
RUN mkdir /data && chown node:node /data
ENV DATA_ROOT=/data
USER node
