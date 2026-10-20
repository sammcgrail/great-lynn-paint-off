FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY server.ts ./
COPY public/ public/
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["bun", "run", "server.ts"]
