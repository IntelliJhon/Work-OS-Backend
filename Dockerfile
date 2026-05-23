# --- BUILD STAGE ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- RUN STAGE ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built code and database migration files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./src/db/migrations

# Expose backend port
EXPOSE 5000

CMD ["sh", "-c", "npm run db:migrate:prod && npm start"]
