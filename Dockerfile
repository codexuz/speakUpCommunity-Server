# Build stage
FROM node:22-alpine AS builder

ENV NODE_ENV=development

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev
RUN npx prisma generate

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Install nginx and ffmpeg
RUN apk add --no-cache nginx ffmpeg

COPY nginx.conf /etc/nginx/nginx.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# 80  → nginx (public-facing)
# 5000 → Node.js (internal only)
EXPOSE 80 5000

CMD ["/docker-entrypoint.sh"]
