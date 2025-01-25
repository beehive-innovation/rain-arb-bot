FROM node:21

# set git sha and docker tag form build time arg to run time env in container
ARG GIT_SHA
ARG DOCKER_CHANNEL
ENV GIT_COMMIT=$GIT_SHA
ENV DOCKER_TAG=$DOCKER_CHANNEL

WORKDIR /arb-bot
ADD . .
RUN rm -rf test/*.js test/*.ts test/e2e
RUN npm install
RUN npm run build
CMD node arb-bot
# ENTRYPOINT ["node" "arb-bot"]