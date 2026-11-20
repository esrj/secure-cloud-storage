# Base image pinned by digest so every build starts from the same bytes. To update it, read the
# new digest with `docker buildx imagetools inspect node:22-alpine` and change tag and digest together.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
RUN apk add --no-cache tzdata
ENV TZ=Asia/Taipei
# && apk add --no-cache openssl=3.3.2-r1 && apk add --no-cache vim && apk add --no-cache tcpdump
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json", "./"]
# npm ci installs exactly what package-lock.json records and fails if the two files disagree.
RUN npm ci --omit=dev --ignore-scripts && mv node_modules ../ \
&& rm -rf /usr/local/lib/node_modules/npm/node_modules/cross-spawn/
# RUN rm -r /usr/lib/node_modules_20/npm/node_modules/cross-spawn/
# RUN rm -r /usr/local/n/versions/node/18.20.5/lib/node_modules/npm/node_modules/cross-spawn/
COPY src ./src
COPY scripts ./scripts
# COPY config ./config
COPY index.js .
COPY CLI.js .
COPY manage.sh ./manage
RUN chmod +x ./manage
EXPOSE 3001
EXPOSE 7002
EXPOSE 7001
EXPOSE 7000
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "start"]
