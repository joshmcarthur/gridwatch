FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY collector/package.json collector/
COPY publisher/package.json publisher/
COPY site/package.json site/
RUN npm ci
COPY collector collector
COPY publisher publisher
ENV DATA_ROOT=/data
