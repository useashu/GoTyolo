FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["sh", "-c", "npm run migrate && npm run seed && npm start"]
