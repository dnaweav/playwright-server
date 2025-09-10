# Playwright image with all Chrome/Firefox/WebKit deps preinstalled
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Install production deps
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of your app
COPY . .

# Railway provides PORT; Playwright image defaults to headless
ENV NODE_ENV=production
ENV PORT=8080

# Start your server
CMD ["npm", "start"]
