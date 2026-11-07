# Собирается из корня репозитория (см. docker-compose.yml)
# Этап 1: Сборка React-приложения
FROM node:20-alpine AS builder

WORKDIR /app

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# Этап 2: Раздача статики через Nginx
FROM nginx:alpine

# Копируем собранные файлы из builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Копируем конфигурацию nginx
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
