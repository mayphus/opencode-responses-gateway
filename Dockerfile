FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/server.ts"]
