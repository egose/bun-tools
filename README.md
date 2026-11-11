# bun-tools

A collection of small Bun-based tools. Each tool lives in its own directory under
`tools/` and is a self-contained Docker build context.

## Layout

```
tools/<name>/
├── main.ts          # entrypoint
├── package.json
├── Dockerfile
└── .dockerignore
```

## Running a tool locally

```sh
cd tools/relay
UPSTREAM=https://api.example.com bun run dev
```

## Building & running a tool with Docker

Each tool directory is its own build context, so Dockerfiles stay simple:

```sh
docker build -t relay tools/relay
docker run --rm -p 8787:8787 -e UPSTREAM=https://api.example.com relay
```

## Adding a new tool

1. `mkdir tools/<name>` and copy the layout above (entrypoint named `main.ts`).
2. Pin the same Bun version as `.tool-versions` in its `Dockerfile` (`oven/bun:<version>`).
3. If the tool gains dependencies, add a `bun.lock` and extend its Dockerfile with a
   `bun install --production --frozen-lockfile` stage.
