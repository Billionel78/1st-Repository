# Image pour tout hébergeur compatible Docker (Railway, Fly.io, Koyeb, un VPS…).
# Variables à fournir à l'exécution : DATABASE_URL (PostgreSQL) et TZ ; COOKIE_SECURE=1 derrière HTTPS.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
EXPOSE 3000
USER node
CMD ["npm", "start"]
