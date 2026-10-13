FROM node:22.12.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"]
