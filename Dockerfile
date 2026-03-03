# Playwright official image includes all Chromium system dependencies
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Copy source
COPY . .

# Expose port (Railway sets $PORT automatically)
EXPOSE 3000

CMD ["npx", "ts-node", "src/server.ts"]
