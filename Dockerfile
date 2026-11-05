# API (NestJS). All'avvio applica le migrazioni mancanti e poi parte.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist dist
COPY database database
EXPOSE 3100
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
