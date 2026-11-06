FROM node:22-alpine
RUN apk update && apk add --no-cache tzdata
ENV TZ=Asia/Taipei
# && apk add --no-cache openssl=3.3.2-r1 && apk add --no-cache vim && apk add --no-cache tcpdump
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json", "./"]
RUN npm install --production --ignore-scripts && mv node_modules ../ \
&& rm -rf /usr/local/lib/node_modules/npm/node_modules/cross-spawn/ || true
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
