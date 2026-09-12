FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run check

CMD ["node", "dist/packages/coordinator/src/index.js"]
