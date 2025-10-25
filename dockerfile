# --------------------------
# Stage 1 — Build dependencies
# --------------------------
FROM node:25-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm install

# Copy source code
COPY . .

# --------------------------
# Stage 2 — Runtime container
# --------------------------
FROM node:25-alpine

WORKDIR /app

# Copy built app and dependencies from builder
COPY --from=builder /app /app

# Set environment variables
ENV NODE_ENV=production
ENV SERVER_HTTP_PORT=3000
ENV SERVER_WS_PORT=3001

# Expose both ports
EXPOSE 3000
EXPOSE 3001

# Run the server
CMD ["node", "main.js"]
