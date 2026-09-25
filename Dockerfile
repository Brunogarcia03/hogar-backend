FROM node:20-alpine

WORKDIR /app

# git es necesario porque una dependencia de Baileys (libsignal) se resuelve
# desde un repo de GitHub, y npm necesita el binario git para eso.
RUN apk add --no-cache git

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
