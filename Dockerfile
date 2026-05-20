FROM ghcr.io/puppeteer/puppeteer:22

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

USER root

WORKDIR /app

COPY package*.json ./
RUN chown -R pptruser:pptruser /app

USER pptruser

RUN npm install

COPY --chown=pptruser:pptruser . .

EXPOSE 8080

CMD ["node", "index.js"]