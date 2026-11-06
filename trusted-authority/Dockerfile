FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN apk add --no-cache g++ make python3
COPY ["package.json", "package-lock.json", "./"]
RUN npm install --omit=dev
COPY src ./src
COPY index.js .
COPY CLI.js .
COPY manage.sh ./manage
RUN chmod +x ./manage

EXPOSE 2999
RUN chown -R 1000 /usr/src/app
USER 1000
CMD ["node", "index.js"]