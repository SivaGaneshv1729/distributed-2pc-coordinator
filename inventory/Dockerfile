FROM node:18-alpine
RUN apk add --no-cache curl
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3001
CMD [ "npm", "start" ]
