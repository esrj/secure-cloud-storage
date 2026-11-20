# Base image pinned by digest so every build starts from the same bytes. To update it, read the
# new digest with `docker buildx imagetools inspect node:22-alpine` and change tag and digest together.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN apk add --no-cache g++ make python3
COPY ["package.json", "package-lock.json", "./"]
# npm ci installs exactly what package-lock.json records and fails if the two files disagree.
RUN npm ci --omit=dev
COPY src ./src
COPY index.js .
COPY CLI.js .
COPY manage.sh ./manage
RUN chmod +x ./manage

EXPOSE 2999
RUN chown -R 1000 /usr/src/app
USER 1000
CMD ["node", "index.js"]