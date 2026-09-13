FROM oven/bun:1-alpine

WORKDIR /app

# Copy package metadata and the lockfile
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --production

# Copy application code
COPY server.js .

EXPOSE 3000

# Execute server using Bun runtime
CMD ["bun", "run", "server.js"]