FROM node:20-alpine
WORKDIR /app

# Install dependencies first (better cache)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm","start"]
