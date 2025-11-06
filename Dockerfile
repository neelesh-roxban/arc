FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "arc-trade-bot.mjs"]
