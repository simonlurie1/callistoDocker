FROM node:20-alpine

# Prisma's query engine needs OpenSSL; without it the engine binary fails
# to load at runtime on Alpine (missing libssl.so).
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/server.js"]
