FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY . .

RUN npm install
CMD ["node", "index.js"]
