# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4

WORKDIR /app

# relay has no dependencies; just ship the entrypoint.
COPY main.ts ./

# 0.0.0.0 so the container port is reachable from outside.
ENV HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# Non-root user shipped with the oven/bun image.
USER bun

CMD ["bun", "main.ts"]
