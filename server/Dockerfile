# Собирается из корня репозитория (см. docker-compose.yml):
# зависимости сервера описаны в корневом package.json
FROM node:20-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходный код сервера
COPY server/ ./

EXPOSE 3001

CMD ["node", "index.js"]
