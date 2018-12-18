FROM node:alpine

WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm i

# Bundle app source
COPY . .

# HTTP server listens on this port
EXPOSE 5000

CMD ["npm", "start"]