# {{name}}

{{description}}

## Features

- Health checks at `GET /health` and `GET /ready`
- Structured JSON logs with a request ID on every line and response
- Consistent JSON errors: `{ code, message, requestId }`
- Request validation with JSON Schema
- Graceful shutdown on `SIGTERM`
- Route files in `src/routes` are loaded automatically

## Run

```sh
npm install
npm start
```

Copy `.env.example` to `.env` and export the values you need for local development. Run the tests with `npm test`.

## Adding routes

Create a file in `src/routes` that default-exports a Fastify plugin. The file name becomes the URL prefix, or export `prefix` to choose your own:

```js
export const prefix = '/hello';

export default async function hello(app) {
  app.get('/', async () => ({ hello: 'world' }));
}
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no | Port the server listens on (default 3000) |
| `LOG_LEVEL` | no | Log level (default info) |
